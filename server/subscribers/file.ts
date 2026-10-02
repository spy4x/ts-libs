/**
 * The mailing-list store in a JSON file, compatible with the files antonshubin.com wrote: list,
 * unsubscribe marks, quarantine and a lock between processes. Ported from spy4x/antonshubin.com
 * (#369).
 *
 * @module
 */

export { LockUnavailableError } from "@spy4x/platform/server/file-lock"
export {
  createFileSubscriberStore,
  type FileSubscriberStore,
  type FileSubscriberStoreOptions,
  SubscriberFileError,
} from "./file-store.ts"
export { createFileSendLog, type FileSendLogOptions } from "./file-send-log.ts"
