import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import Dashboard from "@/pages/Dashboard";

// Minimal query client setup for the dashboard
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true, // Keep status fresh if they tab away and back
      staleTime: 5000,
    }
  }
});

function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-display font-bold text-destructive text-glow">404</h1>
        <h2 className="text-2xl font-mono uppercase tracking-widest text-muted-foreground">Directory Not Found</h2>
        <a href={import.meta.env.BASE_URL} className="inline-block mt-8 px-6 py-3 border border-primary text-primary hover:bg-primary/10 rounded-xl font-display uppercase tracking-wider transition-colors">
          Return to Core
        </a>
      </div>
    </div>
  );
}

function App() {
  // Use the Vite BASE_URL configuration for routing if hosted under a subpath
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={base}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route component={NotFound} />
        </Switch>
      </WouterRouter>
      
      <Toaster 
        theme="dark" 
        position="top-right" 
        toastOptions={{ 
          className: 'font-sans border border-border/50 bg-card/90 backdrop-blur-md text-foreground',
        }} 
      />
    </QueryClientProvider>
  );
}

export default App;
