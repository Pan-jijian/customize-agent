import { ConfigStore } from '@customize-agent/runtime';

let store: ConfigStore | null = null;

export function getConfigStore(): ConfigStore {
  if (!store) store = new ConfigStore();
  return store;
}
