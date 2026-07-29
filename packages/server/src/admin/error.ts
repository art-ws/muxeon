// Operator-facing admin errors (§8.5). Messages are written for the operator and
// carry no secrets or internal paths (§8.7); anything that is not an AdminError
// surfaces as a generic 500 at the plane boundary.

export class AdminError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
