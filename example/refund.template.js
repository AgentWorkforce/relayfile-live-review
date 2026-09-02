export async function refund(request) {
  return issueRefund(request.orderId, request.amount);
}
