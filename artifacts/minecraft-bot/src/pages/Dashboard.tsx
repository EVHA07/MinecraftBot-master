import { LogOut, Activity } from "lucide-react";
import { 
  useGetBotStatus, 
  useGetBotLogs, 
  useDisconnectBot 
} from "@workspace/api-client-react";
import { useBotWebSocket } from "@/hooks/use-bot-websocket";
import { StatusPanel } from "@/components/bot/StatusPanel";
import { ChatPanel } from "@/components/bot/ChatPanel";
import { ConnectOverlay } from "@/components/bot/ConnectOverlay";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function Dashboard() {
  // Use React Query for initial state and polling as fallback, WS handles real-time
  const { data: status, isLoading: statusLoading } = useGetBotStatus({ 
    query: { refetchInterval: 10000, retry: false } 
  });
  const { data: logs } = useGetBotLogs();
  
  const disconnectMutation = useDisconnectBot();
  const { wsState } = useBotWebSocket();

  const handleDisconnect = () => {
    disconnectMutation.mutate(undefined, {
      onError: () => toast.error("Failed to disconnect gracefully")
    });
  };

  const isConnected = !!status?.connected;

  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden flex flex-col">
      {/* Background Image & Effects */}
      <div 
        className="fixed inset-0 z-0 bg-cyber-grid opacity-30"
        style={{ backgroundImage: `url(${import.meta.env.BASE_URL}images/bg-glow.png)` }}
      />
      <div className="fixed inset-0 z-0 bg-gradient-to-b from-background/40 via-background/80 to-background pointer-events-none" />

      {/* Header */}
      <header className="relative z-10 border-b border-border/50 bg-card/40 backdrop-blur-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-10 h-10 bg-primary/20 border border-primary/50 rounded-xl flex items-center justify-center">
              <Activity className="w-5 h-5 text-primary" />
            </div>
            {wsState === 'connected' && (
              <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-success rounded-full border-2 border-background animate-pulse" />
            )}
            {wsState === 'disconnected' && (
              <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-destructive rounded-full border-2 border-background" />
            )}
          </div>
          <div>
            <h1 className="text-xl font-display font-bold uppercase tracking-widest text-glow">MC-Agent Core</h1>
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">WebSocket: {wsState}</p>
          </div>
        </div>

        {isConnected && (
          <Button 
            variant="destructive" 
            size="sm" 
            onClick={handleDisconnect}
            disabled={disconnectMutation.isPending}
            className="shadow-[0_0_15px_rgba(225,29,72,0.2)]"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Terminate
          </Button>
        )}
      </header>

      {/* Main Content Grid */}
      <main className="relative z-10 flex-1 p-4 md:p-6 lg:p-8">
        <div className="max-w-[1600px] mx-auto h-full grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* Left Column: Stats */}
          <div className="lg:col-span-4 xl:col-span-3 space-y-6">
            <StatusPanel status={status} />
            
            {/* Aesthetic decorative element */}
            <div className="hidden lg:block glass-panel rounded-2xl p-4 opacity-50">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] font-display uppercase tracking-widest text-primary">System Integrity</span>
                <span className="text-[10px] font-mono text-muted-foreground">NOMINAL</span>
              </div>
              <div className="w-full h-1 bg-secondary rounded-full overflow-hidden">
                <div className="w-full h-full bg-primary animate-pulse" />
              </div>
            </div>
          </div>

          {/* Right Column: Terminal/Chat */}
          <div className="lg:col-span-8 xl:col-span-9 h-[600px] lg:h-[calc(100vh-140px)]">
            <ChatPanel logs={logs} connected={isConnected} />
          </div>

        </div>
      </main>

      {/* Conditional Connection Overlay */}
      {(!statusLoading && !isConnected) && <ConnectOverlay />}
    </div>
  );
}
