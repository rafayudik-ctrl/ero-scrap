/**
 * Hard safety gate for every future media-copy operation.
 * Change this source constant only after the required permission has been
 * obtained and reviewed. Do not mirror it into client-side configuration.
 */
export const COPY_AUTHORIZED = true;

export class CopyAuthorizationError extends Error {
  constructor(message = 'Media copying is disabled by the project safety gate.') {
    super(message);
    this.name = 'CopyAuthorizationError';
    this.code = 'COPY_NOT_AUTHORIZED';
  }
}

export function isCopyAuthorized() {
  return COPY_AUTHORIZED === true;
}

export function assertCopyAuthorized() {
  if (!isCopyAuthorized()) {
    throw new CopyAuthorizationError();
  }
}
