/**
 * HTTP transport seam. Internal one-turn API only: no SSE, no public ingress.
 */

export interface HttpTransport {
  listen(): Promise<void>;
  close(): Promise<void>;
}
