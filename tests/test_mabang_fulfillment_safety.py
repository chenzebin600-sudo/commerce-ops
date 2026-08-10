import unittest
from unittest.mock import MagicMock, patch

from scripts.mabang_order_source import (
    MabangClient, authoritative_fulfillment_order_id, bind_authoritative_platform_order_ids, extract_fulfillment_stock_flags,
    fulfillment_poll_delay, is_message_only_abnormal,
    response_looks_unauthenticated,
)


class FakeResponse:
    def __init__(self, url='', text=''):
        self.url = url
        self.text = text


class MabangFulfillmentSafetyTests(unittest.TestCase):
    def test_fulfillment_polling_starts_fast_then_backs_off(self):
        self.assertEqual([fulfillment_poll_delay(index) for index in (0, 4, 5, 9, 10, 30)], [1, 1, 2, 2, 3, 3])

    def test_lazada_order_lookup_falls_back_to_sales_record_number(self):
        client = MabangClient()
        client.post_json_with_reauth = MagicMock(side_effect=[
            {'success': True, 'pageHtml': '', 'orderDataList': []},
            {'success': True, 'pageHtml': '', 'orderDataList': [{
                'id': '2021390750',
                'platformId': '7',
                'platformOrderId': '2021390750531159323305217',
                'salesRecordNumber': '531159323305217',
            }]},
        ])

        result = client.find_order_for_fulfillment('531159323305217', '2')

        self.assertEqual(result['salesRecordNumber'], '531159323305217')
        calls = client.post_json_with_reauth.call_args_list
        self.assertEqual(calls[0].kwargs['data']['OrderSearch.fuzzySearchKey'], 'Order.platformOrderId')
        self.assertEqual(calls[1].kwargs['data']['OrderSearch.fuzzySearchKey'], 'Order.salesRecordNumber')

    def test_lazada_uses_sales_record_number_as_authoritative_order_id(self):
        order = {
            'platformId': '7',
            'platformOrderId': '2021390750531159323305217',
            'salesRecordNumber': '531159323305217',
        }

        self.assertEqual(authoritative_fulfillment_order_id(order), '531159323305217')

    def test_restart_state_inspection_reads_all_statuses_without_writing(self):
        client = MabangClient()
        client.find_order_for_fulfillment = MagicMock(return_value={
            'id': '213924888', 'platformOrderId': '260730322HK667',
            'shopId': '2021485965', 'platformId': '17', 'showOrderStatusText': '配货中',
            'trackNumber': 'TRACK-1', 'cansend1logisticsHtml': '<div data-id="1143663">J&amp;T</div>',
        })

        state = client.inspect_fulfillment_order_state('260730322HK667', '1143663', '1143663_1023359_J&T_1591')

        client.find_order_for_fulfillment.assert_called_once_with('260730322HK667', None)
        self.assertEqual(state['orderStatus'], '配货中')
        self.assertEqual(state['trackNumber'], 'TRACK-1')
        self.assertTrue(state['channelMatched'])

    def test_lazada_export_rows_bind_to_authoritative_platform_order_id(self):
        records = [{
            '订单编号': '2021390750531159323305217',
            '交易编号': '531159323305216',
            '平台': 'Lazada',
        }]

        result = bind_authoritative_platform_order_ids(records, ['531159323305217'])

        self.assertEqual(result[0]['交易编号'], '531159323305217')
        self.assertEqual(result[0]['_平台订单号'], '531159323305217')

    def test_targeted_lazada_export_keeps_internal_export_id_but_returns_seller_order_id(self):
        client = MabangClient()
        client.find_order_for_fulfillment = MagicMock(return_value={
            'platformId': '7',
            'platformOrderId': '2021390750531159323305217',
            'salesRecordNumber': '531159323305217',
        })
        client.export_orders_to_records = MagicMock(return_value=[{
            '订单编号': '2021390750531159323305217',
            '交易编号': '531159323305216',
            '平台': 'Lazada',
        }])

        records, matched_ids, missing = client.export_order_references_to_records(['531159323305217'])

        client.export_orders_to_records.assert_called_once_with(['2021390750531159323305217'])
        self.assertEqual(records[0]['交易编号'], '531159323305217')
        self.assertEqual(matched_ids, ['531159323305217'])
        self.assertEqual(missing, [])

    def test_only_one_message_exception_is_eligible_for_review_recovery(self):
        self.assertTrue(is_message_only_abnormal({
            'exceptionInfo': {'count': 1, 'latest': {'name': '有留言'}, 'all': [{'name': '有留言'}]},
        }))
        self.assertFalse(is_message_only_abnormal({
            'exceptionInfo': {'count': 2, 'latest': {'name': '有留言'}, 'all': [{'name': '有留言'}, {'name': '多仓'}]},
        }))
        self.assertFalse(is_message_only_abnormal({'exceptionInfo': {'count': 1, 'latest': {'name': '其他异常'}}}))

    def test_message_review_recovery_uses_exact_request_and_verifies_pending(self):
        client = MabangClient()
        candidate = {
            'internalOrderId': '213924888', 'platformOrderId': '260730322HK667',
            'shopId': '2021485965', 'shopName': 'JOJO Mall', 'platformId': '17',
            'warehouse': '印尼泗水云雀-A仓-1308', 'skuCount': 2, 'eligible': True, 'exclusions': [],
        }
        client.inspect_message_review_candidates = MagicMock(return_value=[candidate])
        response = MagicMock(url='https://example.test/index.php?mod=order.doProcessAbnormalOrders', text='{"success":true}')
        response.json.return_value = {'success': True, 'successCount': 1}
        client.session.post = MagicMock(return_value=response)
        client.find_order_for_fulfillment = MagicMock(return_value={
            'platformOrderId': '260730322HK667', 'shopId': '2021485965', 'orderStatus': '2',
        })

        result = client.recover_message_review_order('260730322HK667', [
            {'shopId': '2021485965', 'shopName': 'JOJO Mall', 'platformId': '17'},
        ])

        self.assertTrue(result['movedToPending'])
        request = client.session.post.call_args
        self.assertTrue(request.args[0].endswith('index.php?mod=order.doProcessAbnormalOrders'))
        self.assertEqual(request.kwargs['data'], {
            'orderIds': '213924888', 'tableBase': '1', 'fixCategory': '3', 'isCheckSecondary': '1',
        })
        client.find_order_for_fulfillment.assert_called_once_with('260730322HK667', '2')

    def test_pending_tracking_channel_reset_matches_confirmed_batch_edit_request(self):
        client = MabangClient()
        pending = {
            'id': '213750846', 'platformOrderId': '26072905HDE2JF',
            'shopId': '2021578358', 'platformId': '17', 'orderStatus': '2',
            'showOrderStatusText': '待处理', 'trackNumber': '',
            'hasGoods': 0, 'orderItemHasGoods': 0,
        }
        client.find_order_for_fulfillment = MagicMock(side_effect=[pending, pending, pending])
        client.post_json_with_reauth = MagicMock(return_value={'success': True, 'isSLogisticsChannel': '2'})
        response = MagicMock()
        response.url = 'https://example.test/index.php?mod=order.all'
        response.text = '{"success":true}'
        response.json.return_value = {'success': True, 'message': '修改成功', 'notFoundPlatformOrderIds': []}
        client.session.post = MagicMock(return_value=response)

        result = client.clear_pending_tracking_channel(
            '26072905HDE2JF', 'fixed-channel-value', '1143663', '2021578358', '17'
        )

        self.assertTrue(result['cleared'])
        request = client.session.post.call_args
        self.assertTrue(request.args[0].endswith('index.php?mod=order.all'))
        self.assertEqual(request.kwargs['data'], [
            ('sourceflag', '1'), ('platformOrderIds', '26072905HDE2JF'), ('order-edit[]', '2'),
            ('selChannel', ''), ('myLogisticsChannelId', ''), ('tableBase', '1'),
            ('isOrderPhz', '1'), ('issecondsyc', '2'), ('confirmActiveFlag', '0'),
        ])

    def test_pending_tracking_channel_reset_accepts_mabang_row_pending_marker(self):
        client = MabangClient()
        pending = {
            'id': '213750846', 'platformOrderId': '26072905HDE2JF',
            'shopId': '2021578358', 'platformId': '17', 'orderStatus': '2', 'showOrderStatusText': '待处理',
            'trackNumber': '', 'hasGoods': 0, 'orderItemHasGoods': 0, 'isSyncLogistics': '1',
            'cansend1logisticsHtml': '<p data-id="1143663">固定渠道</p><a>运单号获取中。。。</a>',
        }
        client.find_order_for_fulfillment = MagicMock(side_effect=[pending, pending, pending])
        client.post_json_with_reauth = MagicMock(return_value={'success': True, 'isSLogisticsChannel': ''})
        response = MagicMock(url='https://example.test/index.php?mod=order.all', text='{"success":true}')
        response.json.return_value = {'success': True, 'notFoundPlatformOrderIds': []}
        client.session.post = MagicMock(return_value=response)

        result = client.clear_pending_tracking_channel(
            '26072905HDE2JF', 'fixed-channel-value', '1143663', '2021578358', '17'
        )

        self.assertTrue(result['cleared'])
        client.session.post.assert_called_once()

    def test_pending_tracking_channel_reset_stops_when_tracking_appears_before_submit(self):
        client = MabangClient()
        pending = {'id': '1', 'platformOrderId': 'P-1', 'shopId': 'S-1', 'platformId': '17',
                   'orderStatus': '2', 'trackNumber': '', 'hasGoods': 0, 'orderItemHasGoods': 0}
        approved = {**pending, 'trackNumber': 'TRACK-1'}
        client.find_order_for_fulfillment = MagicMock(side_effect=[pending, approved])
        client.post_json_with_reauth = MagicMock(return_value={'success': True, 'isSLogisticsChannel': '2'})
        client.session.post = MagicMock()

        with self.assertRaisesRegex(Exception, 'TRACKING_RESET_ORDER_CHANGED'):
            client.clear_pending_tracking_channel('P-1', 'fixed', '1143663', 'S-1', '17')
        client.session.post.assert_not_called()

    @patch('scripts.mabang_order_source.time.sleep', return_value=None)
    def test_existing_tracking_with_matching_channel_moves_directly_to_distribution(self, _sleep):
        client = MabangClient()
        pending = {
            'id': '213467731', 'platformOrderId': '260727RCNK1BWT',
            'shopId': '2021485965', 'platformId': '17',
            'trackNumber': '201672570083', 'showOrderStatusText': '待处理',
            'cansend1logisticsHtml': '<div data-id="1143663">ID-本土-J&amp;TExpress【shopeeV2线上发货(新)】印尼家具</div>',
        }
        distributed = {**pending, 'showOrderStatusText': '配货中'}
        client.find_order_for_fulfillment = MagicMock(side_effect=[pending, distributed])
        client.get_fulfillment_channel_data = MagicMock(return_value={
            'success': True, '_selectedOrderMatched': True, '_orderPageHtml': '',
        })
        response = MagicMock()
        response.url = 'https://example.test/index.php?mod=order.doBatchDistribution'
        response.text = '{"success":true}'
        response.json.return_value = {'success': True, 'message': '已开始配货'}
        client.session.post = MagicMock(return_value=response)

        result = client.distribute_existing_fulfillment(
            '260727RCNK1BWT', '201672570083',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591', '1143663',
            '2021485965', '17', verify_timeout_seconds=15,
        )

        self.assertTrue(result['verified'])
        self.assertEqual(result['afterStatus'], '配货中')
        client.session.post.assert_called_once()
        self.assertEqual(client.session.post.call_args.kwargs['data'], {'orderIds': '213467731', 'type': '1'})

    def test_existing_tracking_with_wrong_channel_is_cleared_then_reenters_normal_fulfillment(self):
        client = MabangClient()
        pending = {
            'id': '213467731', 'platformOrderId': '260727RCNK1BWT',
            'shopId': '2021485965', 'platformId': '17', 'orderStatus': '2',
            'trackNumber': '201672570083', 'showOrderStatusText': '待处理',
            'cansend1logisticsHtml': '<div data-id="9999999">历史交运渠道</div>',
        }
        client.find_order_for_fulfillment = MagicMock(return_value=pending)
        client.clear_mismatched_tracking_channel = MagicMock(return_value={'cleared': True})
        client.submit_fulfillment = MagicMock(return_value={
            'submitted': True, 'verified': True, 'trackingNumber': 'NEW-TRACK', 'afterStatus': '配货中',
        })

        result = client.distribute_existing_fulfillment(
            '260727RCNK1BWT', '201672570083',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591', '1143663',
            '2021485965', '17', verify_timeout_seconds=15,
        )

        self.assertTrue(result['channelReset'])
        self.assertTrue(result['reenteredNormalFulfillment'])
        self.assertEqual(result['trackingNumber'], 'NEW-TRACK')
        client.clear_mismatched_tracking_channel.assert_called_once_with(
            '260727RCNK1BWT', '201672570083',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591', '1143663',
            '2021485965', '17',
        )
        client.submit_fulfillment.assert_called_once()

    def test_wrong_existing_tracking_channel_reset_requires_exact_order_and_verifies_blank(self):
        client = MabangClient()
        wrong = {
            'id': '213467731', 'platformOrderId': '260727RCNK1BWT',
            'shopId': '2021485965', 'platformId': '17', 'orderStatus': '2',
            'trackNumber': '201672570083', 'showOrderStatusText': '待处理',
            'cansend1logisticsHtml': '<div data-id="9999999">历史交运渠道</div>',
        }
        cleared = {**wrong, 'trackNumber': '', 'cansend1logisticsHtml': ''}
        client.find_order_for_fulfillment = MagicMock(side_effect=[wrong, wrong, cleared])
        response = MagicMock(url='https://example.test/index.php?mod=order.all', text='{"success":true}')
        response.json.return_value = {'success': True, 'message': '修改成功', 'notFoundPlatformOrderIds': []}
        client.session.post = MagicMock(return_value=response)

        result = client.clear_mismatched_tracking_channel(
            '260727RCNK1BWT', '201672570083',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591', '1143663',
            '2021485965', '17',
        )

        self.assertTrue(result['cleared'])
        self.assertEqual(result['trackingNumber'], '')
        self.assertEqual(client.session.post.call_args.kwargs['data'], [
            ('sourceflag', '1'), ('platformOrderIds', '260727RCNK1BWT'), ('order-edit[]', '2'),
            ('selChannel', ''), ('myLogisticsChannelId', ''), ('tableBase', '1'),
            ('isOrderPhz', '1'), ('issecondsyc', '2'), ('confirmActiveFlag', '0'),
        ])

    @patch('scripts.mabang_order_source.time.sleep', return_value=None)
    def test_submit_verification_gets_tracking_then_moves_order_to_distribution(self, _sleep):
        client = MabangClient()
        client.prepare_fulfillment = MagicMock(return_value={
            'order': {'orderStatus': '2'},
            'internalOrderId': '213467731',
            'platformOrderId': '260727RCNK1BWT',
            'propertyJson': [],
        })
        submitted = MagicMock()
        submitted.url = 'https://example.test/index.php?mod=order.doReportingInformation'
        submitted.text = '{"success":true}'
        submitted.json.return_value = {'success': True}
        client.session.post = MagicMock(return_value=submitted)
        client.find_order_for_fulfillment = MagicMock(side_effect=[
            {
                'trackNumber': '201600000083',
                'showOrderStatusText': '待处理',
                'isSyncLogistics': '3',
                'cansend1logisticsHtml': '<div data-id="1143663">ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具</div>',
            },
            {
                'trackNumber': '201600000083',
                'showOrderStatusText': '配货中',
                'isSyncLogistics': '3',
                'cansend1logisticsHtml': '<div data-id="1143663">ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具</div>',
            },
        ])

        result = client.submit_fulfillment(
            '260727RCNK1BWT',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591',
            '1143663', verify_timeout_seconds=15
        )

        self.assertTrue(result['verified'])
        self.assertTrue(result['distributionSubmitted'])
        self.assertTrue(result['distributionSuccess'])
        self.assertEqual(result['afterStatus'], '配货中')
        self.assertEqual(set(result['timingsMs']), {
            'prepare', 'submitRequest', 'trackingWait', 'distributionRequest',
            'distributionWait', 'total', 'trackingPollCount', 'distributionPollCount',
        })
        self.assertGreaterEqual(result['timingsMs']['total'], 0)
        distribution_call = client.session.post.call_args_list[1]
        self.assertEqual(distribution_call.kwargs['data'], {'orderIds': '213467731', 'type': '1'})

    def test_post_submit_channel_confirmation_requires_order_id_and_exact_name(self):
        order = {
            'cansend1logisticsHtml':
                '<div data-id="1143663">ID-本土-J&amp;TExpress【shopeeV2线上发货(新)】印尼家具</div>',
        }
        channel_value = '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591'
        self.assertTrue(MabangClient.fulfillment_order_channel_selected(order, '1143663', channel_value))
        self.assertFalse(MabangClient.fulfillment_order_channel_selected(order, '9999999', channel_value))
        self.assertFalse(MabangClient.fulfillment_order_channel_selected(
            {'cansend1logisticsHtml': '<div data-id="1143663">其他渠道</div>'}, '1143663', channel_value
        ))

    def test_nested_channel_html_is_recognized(self):
        response = {
            'success': True,
            'message1': (
                '<div data-mylogisticschannelid="1143663" '
                'data-mylogisticsid="1023359" data-logisticsid="1591"></div>'
            ),
        }
        self.assertTrue(MabangClient.fulfillment_channel_available(
            response,
            '1143663',
            '1143663_1023359_ID-本土-J&TExpress_1591',
        ))

    def test_batch_edit_channel_list_is_the_pre_submit_source_of_truth(self):
        response = {
            'success': True,
            '_orderPageHtml': '''
                <ul id="BatchEdit_myLogisticsChannelModifyUl" role="menu">
                  <li><a onclick="$('#BatchEdit_myLogisticsChannelId').val(
                    '1143663_1023359_ID-本土-J&amp;TExpress【shopeeV2线上发货(新)】印尼家具');">J&amp;T</a></li>
                </ul>
            ''',
        }
        self.assertTrue(MabangClient.batch_edit_channel_available(
            response,
            '1143663',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591',
        ))
        self.assertFalse(MabangClient.batch_edit_channel_available(
            {'_orderPageHtml': '<ul id="BatchEdit_myLogisticsChannelModifyUl"></ul>'},
            '1143663',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591',
        ))

    def test_batch_edit_channel_cache_is_the_raw_http_source_of_truth(self):
        response = {
            '_orderPageHtml': r'''
                <script>
                var highSearch_myLogisticsChannelCache = [
                  {"id":"1143663","source":"1","logisticsId":"1591",
                   "myLogisticsId":"1023359",
                   "logisticsChannelName":"ID-\u672c\u571f-J&TExpress\u3010shopeeV2\u7ebf\u4e0a\u53d1\u8d27(\u65b0)\u3011\u5370\u5c3c\u5bb6\u5177",
                   "logisticsName":"Shopee"}
                ];
                </script>
                <ul id="BatchEdit_myLogisticsChannelModifyUl"></ul>
            ''',
        }
        self.assertEqual(MabangClient.batch_edit_channel_values(response), [
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具',
        ])
        self.assertTrue(MabangClient.batch_edit_channel_available(
            response,
            '1143663',
            '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591',
        ))

    def test_zero_stock_flags_mean_in_stock(self):
        self.assertEqual(
            MabangClient.fulfillment_stock_status({'hasGoods': 0, 'orderItemHasGoods': 0}),
            'in_stock',
        )

    def test_lowercase_stock_flag_keys_are_supported(self):
        self.assertEqual(
            MabangClient.fulfillment_stock_status({'hasgoods': 0, 'orderitemhasgoods': 0}),
            'in_stock',
        )

    def test_snake_case_stock_flag_keys_are_supported(self):
        self.assertEqual(
            MabangClient.fulfillment_stock_status({'hasGoods': 0, 'order_item_has_goods': 0}),
            'in_stock',
        )

    def test_two_stock_flags_mean_out_of_stock(self):
        self.assertEqual(
            MabangClient.fulfillment_stock_status({'hasGoods': 2, 'orderItemHasGoods': 2}),
            'out_of_stock',
        )

    def test_missing_or_unrecognized_stock_flags_fail_closed(self):
        self.assertEqual(MabangClient.fulfillment_stock_status({'hasGoods': 0}), 'unknown')
        self.assertEqual(
            MabangClient.fulfillment_stock_status({'hasGoods': 1, 'orderItemHasGoods': 1}),
            'unknown',
        )

    def test_extracts_flags_only_from_the_matching_order_input(self):
        page_html = '''
          <input value="999" orderid="OTHER" data-hasgoods="2" data-orderitemhasgoods="2">
          <input class="orderCheck" value="213467731" orderid="260727RCNK1BWT"
            data-hasgoods="0" data-orderitemhasgoods="0">
        '''
        self.assertEqual(
            extract_fulfillment_stock_flags(page_html, '213467731', '260727RCNK1BWT'),
            {'hasGoods': '0', 'orderItemHasGoods': '0'},
        )

    def test_missing_matching_order_input_returns_no_flags(self):
        page_html = '<input value="999" orderid="OTHER" data-hasgoods="2" data-orderitemhasgoods="2">'
        self.assertEqual(
            extract_fulfillment_stock_flags(page_html, '213467731', '260727RCNK1BWT'),
            {},
        )

    def test_login_page_redirect_is_detected(self):
        response = FakeResponse(url='https://example.test/index.php?mod=main.loginPage')
        self.assertTrue(response_looks_unauthenticated(response))

    def test_login_form_html_is_detected(self):
        response = FakeResponse(text='<input name="username"><input name="password">')
        self.assertTrue(response_looks_unauthenticated(response))

    def test_normal_json_response_is_not_treated_as_logged_out(self):
        response = FakeResponse(url='https://example.test/index.php?mod=order.oTc', text='{"success":true}')
        self.assertFalse(response_looks_unauthenticated(response, {'success': True}))


if __name__ == '__main__':
    unittest.main()
