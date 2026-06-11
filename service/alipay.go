package service

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/smartwalle/alipay/v3"
)

// BuildAlipayPayQRCode 调用支付宝 alipay.trade.precreate 生成当面付扫码支付二维码内容。
func BuildAlipayPayQRCode(order model.MembershipOrder) (string, error) {
	client, cfg, err := alipayClient()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(cfg.NotifyURL) == "" {
		return "", safeMessageError{message: "支付宝扫码支付需配置异步通知地址"}
	}
	pay := alipay.TradePreCreate{}
	pay.NotifyURL = cfg.NotifyURL
	pay.Subject = zpayTruncateName(order.PlanName)
	pay.OutTradeNo = order.ID
	pay.TotalAmount = fmt.Sprintf("%.2f", float64(order.Amount)/100)
	resp, err := client.TradePreCreate(context.Background(), pay)
	if err != nil {
		return "", safeMessageError{message: "生成支付宝收款码失败：" + err.Error()}
	}
	if resp == nil || !resp.IsSuccess() {
		return "", safeMessageError{message: "生成支付宝收款码失败：" + alipayPreCreateError(resp)}
	}
	if strings.TrimSpace(resp.QRCode) == "" {
		return "", safeMessageError{message: "支付宝未返回收款二维码内容"}
	}
	return resp.QRCode, nil
}

// VerifyAlipayNotify 校验支付宝异步回调签名和订单关键字段。
func VerifyAlipayNotify(r *http.Request) (model.MembershipOrder, error) {
	_, cfg, form, err := verifiedAlipayForm(r)
	if err != nil {
		return model.MembershipOrder{}, err
	}
	if status := form.Get("trade_status"); status != "TRADE_SUCCESS" && status != "TRADE_FINISHED" {
		return model.MembershipOrder{}, safeMessageError{message: "支付未完成"}
	}
	return alipayOrderFromForm(form, cfg, true)
}

// ConfirmAlipayReturn 校验支付宝同步跳转签名，并通过服务端查单确认支付状态。
func ConfirmAlipayReturn(r *http.Request) (model.MembershipOrder, string, bool, error) {
	client, cfg, form, err := verifiedAlipayForm(r)
	if err != nil {
		return model.MembershipOrder{}, "", false, err
	}
	order, err := alipayOrderFromForm(form, cfg, false)
	if err != nil {
		return order, "", false, err
	}
	resp, err := client.TradeQuery(context.Background(), alipay.TradeQuery{OutTradeNo: order.ID})
	if err != nil || resp == nil || !resp.IsSuccess() {
		return order, "", false, nil
	}
	if resp.OutTradeNo != order.ID {
		return order, "", false, nil
	}
	if resp.TradeStatus != alipay.TradeStatusSuccess && resp.TradeStatus != alipay.TradeStatusFinished {
		return order, resp.TradeNo, false, nil
	}
	if !alipayAmountMatches(resp.TotalAmount, order.Amount) {
		return order, resp.TradeNo, false, nil
	}
	return order, resp.TradeNo, true, nil
}

func verifiedAlipayForm(r *http.Request) (*alipay.Client, model.PrivateAlipaySetting, url.Values, error) {
	client, cfg, err := alipayClient()
	if err != nil {
		return nil, cfg, nil, err
	}
	if err := r.ParseForm(); err != nil {
		return nil, cfg, nil, safeMessageError{message: "解析回调参数失败"}
	}
	if err := client.VerifySign(context.Background(), r.Form); err != nil {
		return nil, cfg, nil, safeMessageError{message: "支付宝回调验签失败：" + err.Error()}
	}
	return client, cfg, r.Form, nil
}

func alipayOrderFromForm(form url.Values, cfg model.PrivateAlipaySetting, requireAmount bool) (model.MembershipOrder, error) {
	if appID := strings.TrimSpace(form.Get("app_id")); appID == "" || appID != cfg.AppID {
		return model.MembershipOrder{}, safeMessageError{message: "支付宝回调 AppID 不匹配"}
	}
	orderID := strings.TrimSpace(form.Get("out_trade_no"))
	if orderID == "" {
		return model.MembershipOrder{}, safeMessageError{message: "缺少订单号"}
	}
	order, ok, err := repository.GetMembershipOrder(orderID)
	if err != nil {
		return order, err
	}
	if !ok {
		return order, safeMessageError{message: "订单不存在"}
	}
	if order.PaymentProvider != model.PaymentProviderAlipay {
		return order, safeMessageError{message: "订单支付方式不匹配"}
	}
	if requireAmount && !alipayAmountMatches(form.Get("total_amount"), order.Amount) {
		return order, safeMessageError{message: "支付宝回调金额不匹配"}
	}
	return order, nil
}

func alipayClient() (*alipay.Client, model.PrivateAlipaySetting, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return nil, model.PrivateAlipaySetting{}, err
	}
	cfg := normalizeSettings(settings).Private.Payment.Alipay
	if !cfg.Enabled {
		return nil, cfg, safeMessageError{message: "支付宝直连未开启"}
	}
	if strings.TrimSpace(cfg.AppID) == "" || strings.TrimSpace(cfg.PrivateKey) == "" {
		return nil, cfg, safeMessageError{message: "支付宝直连未配置 AppID 或私钥"}
	}
	client, err := alipay.New(
		cfg.AppID,
		cfg.PrivateKey,
		!cfg.Sandbox,
		alipay.WithSandboxGateway(strings.TrimSpace(cfg.GatewayURL)),
		alipay.WithProductionGateway(strings.TrimSpace(cfg.GatewayURL)),
	)
	if err != nil {
		return nil, cfg, safeMessageError{message: "初始化支付宝客户端失败：" + err.Error()}
	}
	if strings.TrimSpace(cfg.PublicKey) != "" {
		if err := client.LoadAliPayPublicKey(cfg.PublicKey); err != nil {
			return nil, cfg, safeMessageError{message: "加载支付宝公钥失败：" + err.Error()}
		}
	}
	return client, cfg, nil
}

func alipayAmountMatches(value string, cents int) bool {
	parsed, err := yuanToCents(value)
	return err == nil && parsed == cents
}

func alipayPreCreateError(resp *alipay.TradePreCreateRsp) string {
	if resp == nil {
		return "空响应"
	}
	if strings.TrimSpace(resp.SubMsg) != "" {
		return resp.SubMsg
	}
	if strings.TrimSpace(resp.Msg) != "" {
		return resp.Msg
	}
	if strings.TrimSpace(string(resp.Code)) != "" {
		return string(resp.Code)
	}
	return "未知错误"
}

func yuanToCents(value string) (int, error) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, ".")
	if len(parts) > 2 || parts[0] == "" {
		return 0, fmt.Errorf("invalid amount")
	}
	yuan, err := strconv.Atoi(parts[0])
	if err != nil || yuan < 0 {
		return 0, fmt.Errorf("invalid amount")
	}
	fen := 0
	if len(parts) == 2 {
		fraction := parts[1]
		if len(fraction) > 2 {
			return 0, fmt.Errorf("invalid amount")
		}
		for len(fraction) < 2 {
			fraction += "0"
		}
		fen, err = strconv.Atoi(fraction)
		if err != nil {
			return 0, fmt.Errorf("invalid amount")
		}
	}
	return yuan*100 + fen, nil
}
