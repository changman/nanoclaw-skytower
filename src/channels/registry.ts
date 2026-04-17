import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Called when a channel sees a new JID that should be auto-registered, copying config from sourceJid. */
  onAutoRegister?: (newJid: string, sourceJid: string) => void;
  /** Called when a channel wants to register a brand-new group (no source JID to copy from).
   * @param isMain - if true, the group should be registered as the main group */
  onAutoRegisterNew?: (
    jid: string,
    name: string,
    folder: string,
    isMain?: boolean,
  ) => void;
  /** Called when a channel wants to promote an already-registered group to isMain=true. */
  onPromoteToMain?: (jid: string) => void;
  /** Called when a channel reports that a JID should be unregistered (e.g. conversation deleted). */
  onAutoUnregister?: (jid: string) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | Channel[] | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
