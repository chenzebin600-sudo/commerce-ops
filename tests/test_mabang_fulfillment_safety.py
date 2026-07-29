import unittest
from unittest.mock import MagicMock, patch

from scripts.mabang_order_source import MabangClient, extract_fulfillment_stock_flags, response_looks_unauthenticated


class FakeResponse:
    def __init__(self, url='', text=''):
        self.url = url
        self.text = text


class MabangFulfillmentSafetyTests(unittest.TestCase):
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
            '_orderPageHtml': '<div data-mylogisticschannelid="1143663"></div>',
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
            },
            {
                'trackNumber': '201600000083',
                'showOrderStatusText': '配货中',
                'isSyncLogistics': '3',
            },
        ])
        client.get_fulfillment_channel_data = MagicMock(return_value={
            'success': True,
            '_orderPageHtml': '<div data-mylogisticschannelid="1143663"></div>',
        })

        result = client.submit_fulfillment(
            '260727RCNK1BWT', 'fixed-channel-value', '1143663', verify_timeout_seconds=15
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
