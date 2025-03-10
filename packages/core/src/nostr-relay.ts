import {
  BroadcastService,
  Client,
  ClientContext,
  Event,
  EventHandleResult,
  EventId,
  EventRepository,
  EventUtils,
  Filter,
  FilterUtils,
  IncomingMessage,
  Logger,
  MessageType,
  NostrRelayPlugin,
  SubscriptionId,
} from '@nostr-relay/common';
import { endWith, filter, map } from 'rxjs';
import { EventService } from './services/event.service';
import { LocalBroadcastService } from './services/local-broadcast.service';
import { PluginManagerService } from './services/plugin-manager.service';
import { SubscriptionService } from './services/subscription.service';
import {
  LazyCache,
  createOutgoingAuthMessage,
  createOutgoingEoseMessage,
  createOutgoingEventMessage,
  createOutgoingNoticeMessage,
  createOutgoingOkMessage,
} from './utils';

type NostrRelayOptions = {
  domain?: string;
  broadcastService?: BroadcastService;
  logger?: Logger;
  createdAtUpperLimit?: number;
  createdAtLowerLimit?: number;
  minPowDifficulty?: number;
  maxSubscriptionsPerClient?: number;
  filterResultCacheTtl?: number;
  eventHandlingResultCacheTtl?: number;
};

type HandleReqMessageResult = {
  subscriptionId: SubscriptionId;
  filters: Filter[];
  eventCount: number;
};

type HandleEventMessageResult = {
  eventId: EventId;
  success: boolean;
  message?: string;
};

type HandleCloseMessageResult = {
  subscriptionId: SubscriptionId;
  success: boolean;
};

type HandleAuthMessageResult = {
  success: boolean;
  pubkey?: string;
};

type HandleMessageResult =
  | ({ messageType: MessageType.REQ } & HandleReqMessageResult)
  | ({ messageType: MessageType.EVENT } & HandleEventMessageResult)
  | ({ messageType: MessageType.CLOSE } & HandleCloseMessageResult)
  | ({ messageType: MessageType.AUTH } & HandleAuthMessageResult)
  | void;

export class NostrRelay {
  private readonly options: NostrRelayOptions;
  private readonly eventService: EventService;
  private readonly subscriptionService: SubscriptionService;
  private readonly eventHandlingLazyCache:
    | LazyCache<EventId, Promise<EventHandleResult>>
    | undefined;
  private readonly domain?: string;
  private readonly pluginManagerService: PluginManagerService;

  private readonly clientContexts = new Map<Client, ClientContext>();

  constructor(
    eventRepository: EventRepository,
    options: NostrRelayOptions = {},
  ) {
    this.options = options;

    const broadcastService =
      options.broadcastService ?? new LocalBroadcastService();

    this.pluginManagerService = new PluginManagerService();
    this.subscriptionService = new SubscriptionService(
      broadcastService,
      this.clientContexts,
      {
        logger: options.logger,
      },
    );
    this.eventService = new EventService(
      eventRepository,
      broadcastService,
      this.pluginManagerService,
      {
        logger: options.logger,
        createdAtUpperLimit: options.createdAtUpperLimit,
        createdAtLowerLimit: options.createdAtLowerLimit,
        minPowDifficulty: options.minPowDifficulty,
        filterResultCacheTtl: options.filterResultCacheTtl,
      },
    );

    if (options?.eventHandlingResultCacheTtl) {
      this.eventHandlingLazyCache = new LazyCache({
        max: 100 * 1024,
        ttl: options.eventHandlingResultCacheTtl,
      });
    }

    // if domain is not set, it means that NIP-42 is not enabled
    this.domain = options.domain;
  }

  register(plugin: NostrRelayPlugin): NostrRelay {
    this.pluginManagerService.register(plugin);
    return this;
  }

  handleConnection(client: Client): void {
    const ctx = this.getClientContext(client);
    if (this.domain) {
      ctx.sendMessage(createOutgoingAuthMessage(ctx.id));
    }
  }

  handleDisconnect(client: Client): void {
    this.clientContexts.delete(client);
  }

  async handleMessage(
    client: Client,
    message: IncomingMessage,
  ): Promise<HandleMessageResult> {
    if (message[0] === MessageType.EVENT) {
      const [, event] = message;
      const result = await this.handleEventMessage(client, event);
      return {
        messageType: MessageType.EVENT,
        ...result,
      };
    }
    if (message[0] === MessageType.REQ) {
      const [, subscriptionId, ...filters] = message;
      const result = await this.handleReqMessage(
        client,
        subscriptionId,
        filters,
      );
      return {
        messageType: MessageType.REQ,
        ...result,
      };
    }
    if (message[0] === MessageType.CLOSE) {
      const [, subscriptionId] = message;
      const result = this.handleCloseMessage(client, subscriptionId);
      return {
        messageType: MessageType.CLOSE,
        ...result,
      };
    }
    if (message[0] === MessageType.AUTH) {
      const [, signedEvent] = message;
      const result = this.handleAuthMessage(client, signedEvent);
      return {
        messageType: MessageType.AUTH,
        ...result,
      };
    }
    const ctx = this.getClientContext(client);
    ctx.sendMessage(
      createOutgoingNoticeMessage('invalid: unknown message type'),
    );
  }

  async handleEventMessage(
    client: Client,
    event: Event,
  ): Promise<HandleEventMessageResult> {
    const ctx = this.getClientContext(client);
    const callback = async (): Promise<EventHandleResult> => {
      const hookResult =
        await this.pluginManagerService.callBeforeEventHandleHooks(ctx, event);
      if (!hookResult.canContinue) {
        return hookResult.result;
      }

      const handleResult = await this.eventService.handleEvent(ctx, event);

      await this.pluginManagerService.callAfterEventHandleHooks(
        ctx,
        event,
        handleResult,
      );

      return handleResult;
    };

    const handleResult = this.eventHandlingLazyCache
      ? await this.eventHandlingLazyCache.get(event.id, callback)
      : await callback();

    if (handleResult.noReplyNeeded !== true) {
      ctx.sendMessage(
        createOutgoingOkMessage(
          event.id,
          handleResult.success,
          handleResult.message,
        ),
      );
    }

    return {
      eventId: event.id,
      success: handleResult.success,
      message: handleResult.message,
    };
  }

  async handleReqMessage(
    client: Client,
    subscriptionId: SubscriptionId,
    filters: Filter[],
  ): Promise<HandleReqMessageResult> {
    const ctx = this.getClientContext(client);
    if (
      this.domain &&
      filters.some(filter =>
        FilterUtils.hasEncryptedDirectMessageKind(filter),
      ) &&
      !ctx.pubkey
    ) {
      ctx.sendMessage(
        createOutgoingNoticeMessage(
          "restricted: we can't serve DMs to unauthenticated users, does your client implement NIP-42?",
        ),
      );
      return {
        subscriptionId,
        filters,
        eventCount: 0,
      };
    }

    this.subscriptionService.subscribe(ctx, subscriptionId, filters);

    const eventCount = await new Promise<number>((resolve, reject) => {
      let eventCount = 0;
      const event$ = this.eventService.find(filters);
      event$
        .pipe(
          filter(
            event =>
              !this.domain || EventUtils.checkPermission(event, ctx.pubkey),
          ),
          map(event => createOutgoingEventMessage(subscriptionId, event)),
          endWith(createOutgoingEoseMessage(subscriptionId)),
        )
        .subscribe({
          next: message => {
            ctx.sendMessage(message);
            eventCount++;
          },
          error: error => reject(error),
          complete: () => resolve(eventCount),
        });
    });

    return {
      subscriptionId,
      filters,
      eventCount,
    };
  }

  handleCloseMessage(
    client: Client,
    subscriptionId: SubscriptionId,
  ): HandleCloseMessageResult {
    this.subscriptionService.unsubscribe(
      this.getClientContext(client),
      subscriptionId,
    );
    return {
      subscriptionId,
      success: true,
    };
  }

  handleAuthMessage(
    client: Client,
    signedEvent: Event,
  ): HandleAuthMessageResult {
    const ctx = this.getClientContext(client);
    if (!this.domain) {
      ctx.sendMessage(createOutgoingOkMessage(signedEvent.id, true));
      return { success: true };
    }

    const validateErrorMsg = EventUtils.isSignedEventValid(
      signedEvent,
      ctx.id,
      this.domain,
    );
    if (validateErrorMsg) {
      ctx.sendMessage(
        createOutgoingOkMessage(signedEvent.id, false, validateErrorMsg),
      );
      return { success: false };
    }

    ctx.pubkey = EventUtils.getAuthor(signedEvent);
    ctx.sendMessage(createOutgoingOkMessage(signedEvent.id, true));
    return { success: true, pubkey: ctx.pubkey };
  }

  isAuthorized(client: Client): boolean {
    return this.domain ? !!this.getClientContext(client).pubkey : true;
  }

  private getClientContext(client: Client): ClientContext {
    const ctx = this.clientContexts.get(client);
    if (ctx) return ctx;

    const newCtx = new ClientContext(client, {
      maxSubscriptionsPerClient: this.options.maxSubscriptionsPerClient,
    });
    this.clientContexts.set(client, newCtx);
    return newCtx;
  }
}
