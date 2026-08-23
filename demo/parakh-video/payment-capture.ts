type PaymentResponse = { status: number };

export async function capturePayment(paymentId: string): Promise<PaymentResponse> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await sendCaptureRequest(paymentId);
    if (response.status < 500) return response;
  }

  throw new Error('Payment capture failed after retries');
}

async function sendCaptureRequest(paymentId: string): Promise<PaymentResponse> {
  await Promise.resolve(paymentId);
  return { status: 200 };
}
