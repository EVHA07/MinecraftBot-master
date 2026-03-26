import { Activity, MapPin, Shield, Zap, Server, ActivitySquare } from "lucide-react";
import { type BotStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

interface StatusPanelProps {
  status?: BotStatus | null;
}

function ProgressBar({ value, max = 20, colorClass = "bg-primary" }: { value: number; max?: number; colorClass?: string }) {
  const percentage = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="w-full h-3 bg-background rounded-full overflow-hidden border border-border/50 shadow-inner">
      <div
        className={`h-full ${colorClass} transition-all duration-500 ease-out`}
        style={{ width: `${percentage}%`, boxShadow: `0 0 10px var(--tw-shadow-color)` }}
      />
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color = "text-primary", delay = 0 }: { label: string; value: React.ReactNode; icon: any; color?: string; delay?: number }) {
  return (
    <div className="bg-secondary/30 border border-border/50 rounded-xl p-4 flex items-center gap-4 hover:bg-secondary/50 transition-colors group">
      <div className={`p-3 rounded-lg bg-background/50 border border-border/50 ${color} shadow-[0_0_10px_var(--tw-shadow-color)] shadow-current/10 group-hover:shadow-current/30 transition-shadow`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mb-1">{label}</p>
        <p className="text-lg font-display font-bold text-foreground truncate">{value}</p>
      </div>
    </div>
  );
}

export function StatusPanel({ status }: StatusPanelProps) {
  if (!status || !status.connected) {
    return (
      <div className="glass-panel rounded-2xl p-6 h-full flex flex-col items-center justify-center text-center opacity-50 grayscale">
        <ActivitySquare className="w-16 h-16 text-muted-foreground mb-4" />
        <h3 className="text-xl font-display font-bold uppercase tracking-widest text-muted-foreground">System Offline</h3>
        <p className="text-sm text-muted-foreground font-mono mt-2">Awaiting connection...</p>
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-2xl p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <img 
              src={`https://minotar.net/helm/${status.username || 'steve'}/100.png`} 
              alt={status.username || 'Bot'} 
              className="w-12 h-12 rounded-lg border border-border/50 shadow-lg shadow-black/50"
              onError={(e) => { e.currentTarget.src = 'https://minotar.net/helm/steve/100.png' }}
            />
            <span className="absolute -bottom-1 -right-1 flex h-4 w-4">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
              <span className="relative inline-flex rounded-full h-4 w-4 bg-success border-2 border-card"></span>
            </span>
          </div>
          <div>
            <h2 className="text-xl font-display font-bold text-foreground tracking-wide flex items-center gap-2">
              {status.username || 'Unknown'}
              {status.gameMode && (
                 <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">{status.gameMode}</Badge>
              )}
            </h2>
            <p className="text-xs font-mono text-muted-foreground flex items-center gap-1 mt-0.5">
              <Server className="w-3 h-3" />
              {status.host}:{status.port}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex justify-between text-xs font-display font-bold uppercase tracking-widest mb-2">
            <span className="text-destructive flex items-center gap-1"><Shield className="w-3 h-3" /> Health</span>
            <span className="text-foreground">{status.health?.toFixed(1) || 0} / 20</span>
          </div>
          <ProgressBar value={status.health || 0} colorClass="bg-destructive shadow-destructive" />
        </div>
        
        <div>
          <div className="flex justify-between text-xs font-display font-bold uppercase tracking-widest mb-2">
            <span className="text-warning flex items-center gap-1"><Zap className="w-3 h-3" /> Food</span>
            <span className="text-foreground">{status.food?.toFixed(1) || 0} / 20</span>
          </div>
          <ProgressBar value={status.food || 0} colorClass="bg-warning shadow-warning" />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-border/50">
        <StatCard 
          label="Coordinates" 
          value={
            <span className="font-mono text-sm">
              <span className="text-primary mr-1">X</span>{status.position?.x?.toFixed(1) ?? '---'} 
              <span className="text-primary mx-1">Y</span>{status.position?.y?.toFixed(1) ?? '---'} 
              <span className="text-primary mx-1">Z</span>{status.position?.z?.toFixed(1) ?? '---'}
            </span>
          }
          icon={MapPin} 
          color="text-primary" 
        />
        <StatCard 
          label="Server Version" 
          value={<span className="font-mono text-sm">{status.version || 'Unknown'}</span>}
          icon={Activity} 
          color="text-accent" 
        />
      </div>
    </div>
  );
}
