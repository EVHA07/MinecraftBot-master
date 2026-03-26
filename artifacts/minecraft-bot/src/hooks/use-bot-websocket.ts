import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetBotStatusQueryKey, getGetBotLogsQueryKey } from '@workspace/api-client-react';
import type { BotStatus, LogEntry } from '@workspace/api-client-react';
import { toast } from 'sonner';

export type WsState = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useBotWebSocket() {
  const queryClient = useQueryClient();
  const [wsState, setWsState] = useState<WsState>('connecting');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout;
    let isMounted = true;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setWsState('connected');
        // Invalidate status to sync any state changes while disconnected
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      };

      ws.onmessage = (e) => {
        if (!isMounted) return;
        try {
          const { type, data } = JSON.parse(e.data);
          
          if (type === 'status' || type === 'connected' || type === 'disconnected') {
            if (data && typeof data === 'object' && 'connected' in data) {
              queryClient.setQueryData(getGetBotStatusQueryKey(), data as BotStatus);
            } else {
              queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
            }
          }

          if (type === 'connected') {
             toast.success('System Online', { description: 'Bot successfully connected to server.' });
          }

          if (type === 'disconnected') {
             const reason = (data as { reason?: string } | null)?.reason;
             toast.warning('Connection Lost', { 
               description: reason ? `Reason: ${reason}` : 'Bot has left the server.' 
             });
          }

          if (type === 'log') {
            queryClient.setQueryData(getGetBotLogsQueryKey(), (oldLogs: LogEntry[] | undefined) => {
              const currentLogs = oldLogs || [];
              const newEntry = data as LogEntry;
              // Deduplicate by id to avoid conflicts after server restart
              return [newEntry, ...currentLogs.filter(l => l.id !== newEntry.id)];
            });
          }

          if (type === 'error') {
            toast.error('System Alert', { description: data.message || 'Unknown error occurred' });
          }
        } catch (err) {
          console.error('[WS] Failed to parse message', err);
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setWsState('disconnected');
        // Exponential backoff or simple interval
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        if (!isMounted) return;
        setWsState('error');
      };
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [queryClient]);

  return { wsState };
}
