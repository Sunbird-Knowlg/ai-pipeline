import * as restate from '@restatedev/restate-sdk';
import { SleeperOutput, SleeperRequest } from './contract.js';

/** The Restate binding for the fixture workflow. */
export const versionedSleeperApi = restate.iface.workflow('VersionedSleeper', {
  run: restate.iface.schemas({ input: SleeperRequest, output: SleeperOutput }),
  release: restate.iface.shared.json<void, void>(),
});
