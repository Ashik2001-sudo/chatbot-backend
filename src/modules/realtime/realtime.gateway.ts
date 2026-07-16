import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  namespace: '/chat',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  handleConnection(client: Socket) {
    const tenantId = client.handshake.query.tenantId as string;
    if (tenantId) {
      client.join(`tenant:${tenantId}`);
      this.logger.log(`Client ${client.id} joined tenant:${tenantId}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  emitNewMessage(tenantId: string, payload: unknown) {
    this.server.to(`tenant:${tenantId}`).emit('message:new', payload);
  }

  emitConversationUpdated(tenantId: string, payload: unknown) {
    this.server.to(`tenant:${tenantId}`).emit('conversation:updated', payload);
  }

  emitWhatsAppQr(tenantId: string, channelId: string, qr: string) {
    this.server.to(`tenant:${tenantId}`).emit('whatsapp:qr', { channelId, qr });
  }

  emitChannelStatus(tenantId: string, channelId: string, status: string) {
    this.server
      .to(`tenant:${tenantId}`)
      .emit('channel:status', { channelId, status });
  }

  emitHistorySyncProgress(
    tenantId: string,
    payload: {
      channelId: string;
      progress: number | null;
      imported: number;
      done: boolean;
    },
  ) {
    this.server.to(`tenant:${tenantId}`).emit('history:progress', payload);
  }
}
