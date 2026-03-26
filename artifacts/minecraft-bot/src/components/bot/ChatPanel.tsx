import { useState } from "react";
import { Send, Terminal } from "lucide-react";
import { format } from "date-fns";
import { useSendBotChat, type LogEntry } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface ChatPanelProps {
  logs?: LogEntry[];
  connected: boolean;
}

function LogItem({ log }: { log: LogEntry }) {
  const getBadgeProps = (type: string) => {
    switch (type) {
      case 'chat': return { variant: 'outline' as const, color: 'text-foreground' };
      case 'join': return { variant: 'success' as const, color: 'text-success' };
      case 'leave': return { variant: 'warning' as const, color: 'text-warning' };
      case 'death': return { variant: 'destructive' as const, color: 'text-destructive' };
      case 'error': return { variant: 'destructive' as const, color: 'text-destructive font-bold' };
      case 'system': return { variant: 'default' as const, color: 'text-primary' };
      default: return { variant: 'secondary' as const, color: 'text-muted-foreground' };
    }
  };

  const style = getBadgeProps(log.type);

  return (
    <div className="py-2 px-3 border-b border-border/30 last:border-0 hover:bg-white/[0.02] rounded-md transition-colors flex items-start gap-3 group">
      <span className="text-muted-foreground/50 font-mono text-[10px] whitespace-nowrap mt-1 group-hover:text-muted-foreground transition-colors">
        {format(new Date(log.timestamp), 'HH:mm:ss')}
      </span>
      <Badge variant={style.variant} className={`h-5 mt-0.5 text-[9px] px-1.5`}>
        {log.type}
      </Badge>
      <span className={`font-mono text-sm break-words flex-1 leading-relaxed ${style.color}`}>
        {log.message}
      </span>
    </div>
  );
}

export function ChatPanel({ logs, connected }: ChatPanelProps) {
  const [message, setMessage] = useState('');
  const sendMutation = useSendBotChat();

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !connected) return;
    
    sendMutation.mutate({ data: { message } }, {
      onSuccess: () => setMessage(''),
      onError: (err) => console.error('Failed to send message', err)
    });
  };

  return (
    <div className="glass-panel rounded-2xl h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border/50 bg-secondary/30 flex items-center gap-3">
        <Terminal className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-display font-bold uppercase tracking-widest text-foreground">Terminal & Comm Link</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 flex flex-col-reverse relative">
        {(!logs || logs.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground font-mono text-sm opacity-50">
            [ NO LOGS AVAILABLE ]
          </div>
        )}
        {logs?.map((log) => (
          <LogItem key={`${log.id}-${log.timestamp}`} log={log} />
        ))}
      </div>

      <div className="p-4 border-t border-border/50 bg-background/50">
        <form onSubmit={handleSend} className="flex gap-3">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={connected ? "Enter command or message..." : "System disconnected..."}
            className="flex-1 font-mono"
            disabled={!connected || sendMutation.isPending}
            autoComplete="off"
          />
          <Button 
            type="submit" 
            disabled={!message.trim() || !connected || sendMutation.isPending} 
            className="px-6 md:px-8"
          >
            <span className="hidden sm:inline">TRANSMIT</span>
            <Send className="w-4 h-4 sm:ml-2" />
          </Button>
        </form>
      </div>
    </div>
  );
}
