// Browsers still probe /favicon.ico even when the page advertises icon.svg.
export function GET(request: Request): Response {
  return Response.redirect(new URL("/icon.svg", request.url), 307);
}
