/** One error type for the server layer; `errorResponse` maps its status. Core uses `ValidationError`. */
export class HttpError extends Error {
  /** `code` is a stable machine-readable reason (e.g. `strategy_gate`), returned as `{ error, code }`. */
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}
