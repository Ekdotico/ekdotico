// The one module from which the application obtains the Istorico port (contract
// IC-49). Nothing else imports ./port.ts for its adapter. In α 0.1.0 it returns
// the no-op adapter; the release that links Istorico changes this module and no
// call site.
//
// A caller decides what to do from the capabilities the port reports, never
// from the adapter's name (IC-14). A port method returns a Result and does not
// throw (IC-10).
import { CONTRACT_VERSION, noopAdapter, type IstoricoPort } from './port.ts';

export type * from './port.ts';
export { CONTRACT_VERSION };

export function istorico(): IstoricoPort {
  return noopAdapter;
}

/**
 * IC-41: a process refuses to start where the adapter was built against another
 * version of the contract. It cannot fail while the adapter is the repository's
 * own copy; it is here so that adopting the contract package adds no call.
 */
export function assertContractVersion(port: IstoricoPort = istorico()): void {
  const { contractVersion } = port.capabilities();
  if (contractVersion !== CONTRACT_VERSION) {
    throw new Error(
      `The Istorico adapter implements contract ${contractVersion}; this application is built against ${CONTRACT_VERSION}.`,
    );
  }
}
