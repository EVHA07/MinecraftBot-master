import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion } from "framer-motion";
import { Server, Wifi } from "lucide-react";
import { useConnectBot, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import type { BotStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const connectSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.coerce.number().min(1).max(65535).default(25565),
  username: z.string().min(1, "Username is required").max(16, "Username too long"),
  version: z.string().optional()
});

type ConnectFormData = z.infer<typeof connectSchema>;

export function ConnectOverlay() {
  const queryClient = useQueryClient();
  const connectMutation = useConnectBot();
  
  const form = useForm<ConnectFormData>({
    resolver: zodResolver(connectSchema),
    defaultValues: {
      host: "localhost",
      port: 25565,
      username: "ReplitBot",
      version: ""
    }
  });

  const onSubmit = (data: ConnectFormData) => {
    connectMutation.mutate({ data }, {
      onSuccess: (responseData) => {
        queryClient.setQueryData(getGetBotStatusQueryKey(), responseData as BotStatus);
      },
      onError: (err) => {
         const detail = (err.data as { error?: string } | null)?.error ?? err.message;
         toast.error("Connection Failed", { description: detail });
      }
    });
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md"
    >
      <motion.div 
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        className="w-full max-w-md glass-panel rounded-3xl overflow-hidden border border-primary/30 shadow-[0_0_50px_rgba(0,182,212,0.15)] relative"
      >
        {/* Glow effect */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-32 bg-primary/20 blur-[60px] pointer-events-none" />
        
        <div className="p-8 relative z-10">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center border border-border mb-4 shadow-inner">
              <Server className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-3xl font-display font-bold text-foreground uppercase tracking-widest text-glow">Init Sequence</h2>
            <p className="text-muted-foreground text-sm font-mono mt-2">Establish remote connection to server core</p>
          </div>

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="host">Host Address</Label>
                <Input 
                  id="host" 
                  placeholder="play.server.com" 
                  {...form.register("host")} 
                  className={form.formState.errors.host ? "border-destructive" : ""}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="port">Port</Label>
                <Input 
                  id="port" 
                  type="number" 
                  placeholder="25565" 
                  {...form.register("port")} 
                  className={form.formState.errors.port ? "border-destructive" : ""}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Agent Identity (Username)</Label>
              <Input 
                id="username" 
                placeholder="ReplitBot" 
                {...form.register("username")} 
                className={form.formState.errors.username ? "border-destructive" : ""}
              />
              {form.formState.errors.username && (
                <p className="text-xs text-destructive mt-1 font-mono">{form.formState.errors.username.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="version">Target Protocol Version (Optional)</Label>
              <Input 
                id="version" 
                placeholder="Auto-detect or e.g. 1.20.4" 
                {...form.register("version")} 
              />
            </div>

            <Button 
              type="submit" 
              className="w-full mt-8 h-14 text-lg" 
              disabled={connectMutation.isPending}
            >
              {connectMutation.isPending ? (
                <span className="flex items-center gap-2 animate-pulse">
                  <Wifi className="w-5 h-5" /> Establishing Uplink...
                </span>
              ) : (
                "Engage Connection"
              )}
            </Button>
          </form>
        </div>
      </motion.div>
    </motion.div>
  );
}
