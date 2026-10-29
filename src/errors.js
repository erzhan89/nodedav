import { el } from './xml.js';
import { d } from './ns.js';

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} [message]
   * @param {{ headers?: Record<string,string>, xml?: object }} [opts] xml: element tree sent as body
   */
  constructor(status, message = '', { headers = {}, xml = null } = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.xml = xml;
  }
}

/** Error with a WebDAV <D:error> body carrying a precondition / postcondition element. */
export const davError = (status, ...conditions) =>
  new HttpError(status, '', { xml: el(d('error'), null, ...conditions) });
