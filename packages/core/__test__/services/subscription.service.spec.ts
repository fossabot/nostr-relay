import {
  BroadcastService,
  Client,
  ClientContext,
  ClientReadyState,
  Event,
  EventUtils,
  Filter,
  MessageType,
} from '../../../common';
import { LocalBroadcastService } from '../../src/services/local-broadcast.service';
import { SubscriptionService } from '../../src/services/subscription.service';

describe('SubscriptionService', () => {
  let subscriptionService: SubscriptionService;
  let broadcastService: BroadcastService;
  let client: Client;
  let ctx: ClientContext;
  let clientsMap: Map<Client, ClientContext>;

  beforeEach(() => {
    clientsMap = new Map<Client, ClientContext>();
    broadcastService = new LocalBroadcastService();
    subscriptionService = new SubscriptionService(
      broadcastService,
      clientsMap,
      {
        logger: {
          error: jest.fn(),
        },
      },
    );
    client = {
      readyState: ClientReadyState.OPEN,
      send: jest.fn(),
    };
    ctx = new ClientContext(client);
    clientsMap.set(client, ctx);
  });

  describe('subscribe', () => {
    it('should add subscription', () => {
      const subscriptionId = 'subscriptionId';
      const filters = [{}] as Filter[];

      subscriptionService.subscribe(ctx, subscriptionId, filters);

      expect(ctx.subscriptions.get(subscriptionId)).toEqual(filters);
    });

    it('should add subscription to existing client', () => {
      const subscriptionIdA = 'subscriptionIdA';
      const subscriptionIdB = 'subscriptionIdB';
      const filtersA = [{}] as Filter[];
      const filtersB = [{}, {}] as Filter[];

      subscriptionService.subscribe(ctx, subscriptionIdA, filtersA);
      subscriptionService.subscribe(ctx, subscriptionIdB, filtersB);

      expect(ctx.subscriptions.get(subscriptionIdA)).toEqual(filtersA);
      expect(ctx.subscriptions.get(subscriptionIdB)).toEqual(filtersB);
    });
  });

  describe('unsubscribe', () => {
    it('should remove subscription', () => {
      const subscriptionIdA = 'subscriptionIdA';
      const subscriptionIdB = 'subscriptionIdB';
      const filtersA = [{}] as Filter[];
      const filtersB = [{}, {}] as Filter[];

      subscriptionService.subscribe(ctx, subscriptionIdA, filtersA);
      subscriptionService.subscribe(ctx, subscriptionIdB, filtersB);

      expect(
        subscriptionService.unsubscribe(ctx, subscriptionIdA),
      ).toBeTruthy();

      expect(ctx.subscriptions.get(subscriptionIdA)).toBeUndefined();
      expect(ctx.subscriptions.get(subscriptionIdB)).toEqual(filtersB);
    });

    it('should return false if client is not found', () => {
      const subscriptionId = 'subscriptionId';

      expect(subscriptionService.unsubscribe(ctx, subscriptionId)).toBeFalsy();
    });
  });

  describe('eventListener', () => {
    it('should broadcast event to client', async () => {
      const subscriptionId = 'subscriptionId';
      const filters = [{}] as Filter[];
      const event = {
        id: 'id',
      } as Event;

      jest.spyOn(EventUtils, 'isMatchingFilter').mockReturnValue(true);

      subscriptionService.subscribe(ctx, subscriptionId, filters);
      broadcastService.broadcast(event);

      await new Promise(resolve => process.nextTick(resolve));

      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify([MessageType.EVENT, subscriptionId, event]),
      );
    });

    it('should not broadcast event to client if not matching filter', async () => {
      const subscriptionId = 'subscriptionId';
      const filters = [{}] as Filter[];
      const event = {
        id: 'id',
      } as Event;

      jest.spyOn(EventUtils, 'isMatchingFilter').mockReturnValue(false);

      subscriptionService.subscribe(ctx, subscriptionId, filters);
      broadcastService.broadcast(event);

      await new Promise(resolve => process.nextTick(resolve));

      expect(client.send).not.toHaveBeenCalled();
    });

    it('should not broadcast event to client if client is not open', async () => {
      const subscriptionId = 'subscriptionId';
      const filters = [{}] as Filter[];
      const event = {
        id: 'id',
      } as Event;

      jest.spyOn(EventUtils, 'isMatchingFilter').mockReturnValue(true);

      client.readyState = ClientReadyState.CLOSED;
      subscriptionService.subscribe(ctx, subscriptionId, filters);
      broadcastService.broadcast(event);

      await new Promise(resolve => process.nextTick(resolve));

      expect(client.send).not.toHaveBeenCalled();
    });

    it('should catch error', async () => {
      const subscriptionId = 'subscriptionId';
      const filters = [{}] as Filter[];
      const event = {
        id: 'id',
      } as Event;

      jest.spyOn(EventUtils, 'isMatchingFilter').mockImplementation(() => {
        throw new Error('error');
      });

      subscriptionService.subscribe(ctx, subscriptionId, filters);
      broadcastService.broadcast(event);

      await new Promise(resolve => process.nextTick(resolve));

      expect(client.send).not.toHaveBeenCalled();
      expect(subscriptionService['logger'].error).toHaveBeenCalled();
    });
  });
});
