import {
  AfterEventBroadcast,
  AfterEventHandle,
  BeforeEventBroadcast,
  BeforeEventHandle,
  BeforeEventHandleResult,
  BeforeHookResult,
  ClientContext,
  Event,
  EventHandleResult,
  NostrRelayPlugin,
} from '@nostr-relay/common';

export class PluginManagerService {
  private readonly beforeEventHandlePlugins: BeforeEventHandle[] = [];
  private readonly afterEventHandlePlugins: AfterEventHandle[] = [];
  private readonly beforeEventBroadcastPlugins: BeforeEventBroadcast[] = [];
  private readonly afterEventBroadcastPlugins: AfterEventBroadcast[] = [];

  register(plugin: NostrRelayPlugin): void {
    if (this.hasBeforeEventHandleHook(plugin)) {
      this.beforeEventHandlePlugins.push(plugin);
    }
    if (this.hasAfterEventHandleHook(plugin)) {
      this.afterEventHandlePlugins.unshift(plugin);
    }
    if (this.hasBeforeEventBroadcastHook(plugin)) {
      this.beforeEventBroadcastPlugins.push(plugin);
    }
    if (this.hasAfterEventBroadcastHook(plugin)) {
      this.afterEventBroadcastPlugins.unshift(plugin);
    }
  }

  async callBeforeEventHandleHooks(
    ctx: ClientContext,
    event: Event,
  ): Promise<BeforeEventHandleResult> {
    for await (const plugin of this.beforeEventHandlePlugins) {
      const result = await plugin.beforeEventHandle(ctx, event);
      if (!result.canContinue) return result;
    }
    return { canContinue: true };
  }

  async callAfterEventHandleHooks(
    ctx: ClientContext,
    event: Event,
    handleResult: EventHandleResult,
  ): Promise<void> {
    for await (const plugin of this.afterEventHandlePlugins) {
      await plugin.afterEventHandle(ctx, event, handleResult);
    }
  }

  async callBeforeEventBroadcastHooks(
    ctx: ClientContext,
    event: Event,
  ): Promise<BeforeHookResult> {
    for await (const plugin of this.beforeEventBroadcastPlugins) {
      const result = await plugin.beforeEventBroadcast(ctx, event);
      if (!result.canContinue) return result;
    }
    return { canContinue: true };
  }

  async callAfterEventBroadcastHooks(
    ctx: ClientContext,
    event: Event,
  ): Promise<void> {
    for await (const plugin of this.afterEventBroadcastPlugins) {
      await plugin.afterEventBroadcast(ctx, event);
    }
  }

  private hasBeforeEventHandleHook(
    plugin: NostrRelayPlugin,
  ): plugin is BeforeEventHandle {
    return (
      typeof (plugin as BeforeEventHandle).beforeEventHandle === 'function'
    );
  }

  private hasAfterEventHandleHook(
    plugin: NostrRelayPlugin,
  ): plugin is AfterEventHandle {
    return typeof (plugin as AfterEventHandle).afterEventHandle === 'function';
  }

  private hasBeforeEventBroadcastHook(
    plugin: NostrRelayPlugin,
  ): plugin is BeforeEventBroadcast {
    return (
      typeof (plugin as BeforeEventBroadcast).beforeEventBroadcast ===
      'function'
    );
  }

  private hasAfterEventBroadcastHook(
    plugin: NostrRelayPlugin,
  ): plugin is AfterEventBroadcast {
    return (
      typeof (plugin as AfterEventBroadcast).afterEventBroadcast === 'function'
    );
  }
}
