export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    const forwardedHost = request.headers
      .get("x-forwarded-host")
      ?.split(",")[0]
      .trim();
    const host = forwardedHost || request.headers.get("host") || requestUrl.host;
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      .trim();
    const protocol = forwardedProtocol || requestUrl.protocol.slice(0, -1);
    const requestOrigin = new URL(`${protocol}://${host}`).origin;

    return originUrl.origin === requestOrigin;
  } catch {
    return false;
  }
}
