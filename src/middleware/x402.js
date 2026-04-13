const HIVE_PAYMENT_ADDRESS = process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';

export function requirePayment(priceUsdc, serviceName = 'HiveLaw Service') {
  return (req, res, next) => {
    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    if (paymentHash) { req.paymentVerified = true; req.paymentHash = paymentHash; return next(); }

    const subscriptionId = req.headers['x-subscription-id'];
    if (subscriptionId) { req.subscriptionVerified = true; return next(); }

    const internalKey = req.headers['x-hive-internal-key'];
    if (internalKey && internalKey === (process.env.HIVE_INTERNAL_KEY || 'hivelaw-dev-key')) { req.paymentVerified = true; return next(); }

    // Dev mode: bypass payment
    if (process.env.NODE_ENV !== 'production') { req.paymentVerified = true; req.paymentBypassed = true; return next(); }

    return res.status(402).json({
      status: '402 Payment Required',
      service: serviceName,
      payment: {
        amount_usdc: priceUsdc,
        currency: 'USDC',
        network: 'Base L2',
        recipient_address: HIVE_PAYMENT_ADDRESS,
      },
      headers_to_include: {
        'X-Payment-Hash': '<USDC transaction hash on Base L2>',
        'X-Subscription-Id': '<Active subscription ID>',
      },
    });
  };
}
