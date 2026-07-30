import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from scripts.mabang_order_source import (
    MabangClient, extract_fulfillment_stock_flags, extract_shipping_deadline,
    is_message_only_abnormal, response_looks_unauthenticated,
)


class FakeResponse:
    def __init__(self, url='', text=''):
        self.url = url
        self.text = text


class MabangFulfillmentSafetyTests(unittest.TestCase):
    def test_manual_tracking_resolution_reads_across_statuses_without_submitting(self):
        client = MabangClient()
        client.find_order_for_fulfillment = MagicMock(return_value={
            'platformOrderId': '26072905HDE2JF', 'orderStatus': '3',
            'showOrderStatusText': '配货中', 'trackNumber': '201672570083',
        })
        result = client.inspect_manual_tracking_resolution('26072905HDE2JF')
        self.assertEqual(result['orderStatusText'], '配货中')
        self.assertEqual(result['trackNumber'], '201672570083')
        client.find_order_for_fulfillment.assert_called_once_with('26072905HDE2JF', None)

    def test_only_one_message_exception_is_eligible_for_review_recovery(self):
        self.assertTrue(is_message_only_abnormal({
            'exceptionInfo': {'count': 1, 'latest': {'name': '有留言'}, 'all': [{'name': '有留言'}]},
        }))
        self.assertFalse(is_message_only_abnormal({
            'exceptionInfo': {'count': 2, 'latest': {'name': '有留言'}, 'all': [{'name': '有留言'}, {'name': '多仓'}]},
        }))
        self.assertFalse(is_message_only_abnormal({'exceptionInfo': {'count': 1, 'latest': {'name': '其他异常'}}}))

    def test_message_review_recovery_uses_exact_mabang_request_and_verifies_pending(self):
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

    def test_mabang_remaining_shipping_time_becomes_absolute_deadline(self):
        now = datetime(2026, 7, 30, 10, 0, tzinfo=timezone(timedelta(hours=8)))
        self.assertEqual(
            extract_shipping_deadline({'closeDateType': '2', 'closeDateText': '1 天 7 小时 15 分'}, now),
            '2026-07-31T17:15:00+08:00',
        )
        self.assertEqual(
            extract_shipping_deadline({'closeDateType': '1', 'closeDay': '0 天 2 小时 5 分'}, now),
            '2026-07-30T07:55:00+08:00',
        )

    def test_shipping_deadline_is_merged_into_every_exported_sku_row(self):
        client = MabangClient()
        client.remember_shipping_deadlines([
            {'platformOrderId': 'ORDER-1', 'closeDateType': '2', 'closeDateText': '0 天 6 小时 0 分'},
        ], datetime(2026, 7, 30, 10, 0, tzinfo=timezone(timedelta(hours=8))))
        records = client.merge_shipping_deadlines([
            {'订单编号': 'ORDER-1', 'SKU': 'A'}, {'订单编号': 'ORDER-1', 'SKU': 'B'},
        ])
        self.assertEqual(records[0]['最后发货期限'], '2026-07-30T16:00:00+08:00')
        self.assertEqual(records[1]['最后发货期限'], '2026-07-30T16:00:00+08:00')

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
    def test_existing_tracking_can_move_to_distribution_without_resubmitting_fulfillment(self, _sleep):
        client = MabangClient()
        pending = {
            'id': '213467731', 'platformOrderId': '260727RCNK1BWT',
            'shopId': '2021485965', 'platformId': '17',
            'trackNumber': '201672570083', 'showOrderStatusText': '待处理',
        }
        distributed = {**pending, 'showOrderStatusText': '配货中'}
        client.find_order_for_fulfillment = MagicMock(side_effect=[pending, distributed])
        client.get_fulfillment_channel_data = MagicMock(return_value={
            'success': True, '_selectedOrderMatched': True,
            'message1': '<div data-mylogisticschannelid="1143663"></div>',
        })
        response = MagicMock()
        response.url = 'https://example.test/index.php?mod=order.doBatchDistribution'
        response.text = '{"success":true}'
        response.json.return_value = {'success': True, 'message': '已开始配货'}
        client.session.post = MagicMock(return_value=response)

        result = client.distribute_existing_fulfillment(
            '260727RCNK1BWT', '201672570083', 'fixed-channel-value', '1143663',
            '2021485965', '17', verify_timeout_seconds=15,
        )

        self.assertTrue(result['verified'])
        self.assertEqual(result['afterStatus'], '配货中')
        client.session.post.assert_called_once()
        self.assertEqual(client.session.post.call_args.kwargs['data'], {'orderIds': '213467731', 'type': '1'})

    @patch('scripts.mabang_order_source.time.sleep', return_value=None)
    def test_submit_verification_uses_exact_configured_channel_when_candidates_disappear(self, _sleep):
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
            },
            {
                'trackNumber': '201600000083',
                'showOrderStatusText': '配货中',
                'isSyncLogistics': '3',
            },
        ])
        client.get_fulfillment_channel_data = MagicMock(return_value={
            'success': True,
            '_selectedOrderMatched': True,
            'message1': '<div>selected order, but no channel candidates after tracking</div>',
            '_orderPageHtml': (
                '{"id":"1143663","myLogisticsId":"1023359",'
                '"logisticsId":"1591","logisticsChannelName":"fixed-channel-name"}'
            ),
        })

        result = client.submit_fulfillment(
            '260727RCNK1BWT', '1143663_1023359_fixed-channel-name_1591', '1143663',
            verify_timeout_seconds=15
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
        client.get_fulfillment_channel_data.assert_called_once_with('213467731')
        distribution_call = client.session.post.call_args_list[1]
        self.assertEqual(distribution_call.kwargs['data'], {'orderIds': '213467731', 'type': '1'})

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

    def test_batch_edit_channel_cache_is_matched_exactly(self):
        page_html = '''<script>var channels=[
          {"id":"1143663","source":"1","logisticsId":"1591","myLogisticsId":"1023359",
           "logisticsChannelName":"ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具",
           "logisticsName":"shopeeV2线上发货(新)"}
        ];</script>'''
        expected = '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591'
        self.assertTrue(MabangClient.configured_fulfillment_channel_available(
            page_html, '1143663', expected,
        ))
        self.assertFalse(MabangClient.configured_fulfillment_channel_available(
            page_html, '1143663', expected.replace('_1023359_', '_999999_'),
        ))
        self.assertFalse(MabangClient.configured_fulfillment_channel_available(
            page_html, '1143663', expected.replace('_1591', '_9999'),
        ))

    def test_prepare_accepts_exact_batch_edit_channel_then_checks_order_reporting(self):
        client = MabangClient()
        expected = '1143663_1023359_ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具_1591'
        client.find_order_for_fulfillment = MagicMock(return_value={
            'id': '213947054', 'platformOrderId': '2607303BV291YE',
            'shopId': '2021557966', 'platformId': '17', 'orderStatus': '2',
            'trackNumber': '', 'hasGoods': '0', 'orderItemHasGoods': '0',
        })
        client.get_fulfillment_channel_data = MagicMock(return_value={
            'success': True, '_selectedOrderMatched': True,
            'message1': '<div data-order-id="213947054"></div>',
            '_orderPageHtml': '''<script>var channels=[
              {"id":"1143663","source":"1","logisticsId":"1591","myLogisticsId":"1023359",
               "logisticsChannelName":"ID-本土-J&TExpress【shopeeV2线上发货(新)】印尼家具",
               "logisticsName":"shopeeV2线上发货(新)"}
            ];</script>''',
        })
        client.post_json_with_reauth = MagicMock(return_value={
            'success': True, 'notFoundPlatformOrderIds': [], 'isSLogisticsChannel': '1',
            'stockHtml': '', 'propertyJson': [],
        })

        result = client.prepare_fulfillment(
            '2607303BV291YE', expected, '1143663', '2021557966', '17', True,
        )

        self.assertTrue(result['channelMatched'])
        client.post_json_with_reauth.assert_called_once()

    def test_zero_stock_flags_mean_in_stock(self):
        current_markup = {
            'success': True,
            'message1': '<a onclick="$(\'#channel\').val(\'1143663_1023359_ID-JT-Local\');">select</a>',
        }
        self.assertTrue(MabangClient.fulfillment_channel_available(
            current_markup, '1143663', '1143663_1023359_ID-JT-Local_1591',
        ))
        wrong_provider_markup = {
            'success': True,
            'message1': '<a onclick="$(\'#channel\').val(\'1143663_999999_ID-JT-Local\');">select</a>',
        }
        self.assertFalse(MabangClient.fulfillment_channel_available(
            wrong_provider_markup, '1143663', '1143663_1023359_ID-JT-Local_1591',
        ))
        generic_page_only = {
            'success': True,
            'message1': '<div>no channel for selected order</div>',
            '_orderPageHtml': '<div data-mylogisticschannelid="1143663"></div>',
        }
        self.assertFalse(MabangClient.fulfillment_channel_available(
            generic_page_only, '1143663', '1143663_1023359_ID-JT-Local_1591',
        ))

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
