"use client";

import { Sun, Moon, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback } from "react";
import { Logo } from "@/components/logo";

export function Header() {
  const [isDark, setIsDark] = useState(true);
  const [isRainbow, setIsRainbow] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const dark = stored !== "light";
    setIsDark(dark);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);

    const rainbow = localStorage.getItem("rainbow") === "true";
    setIsRainbow(rainbow);
    document.documentElement.classList.toggle("rainbow", rainbow);
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("theme", next ? "dark" : "light");
      document.documentElement.classList.toggle("dark", next);
      document.documentElement.classList.toggle("light", !next);
      return next;
    });
  }, []);

  const toggleRainbow = useCallback(() => {
    setIsRainbow((prev) => {
      const next = !prev;
      localStorage.setItem("rainbow", String(next));
      document.documentElement.classList.toggle("rainbow", next);
      return next;
    });
  }, []);

  return (
    <header className="sticky top-0 z-40 flex items-center justify-between h-12 px-4 border-b border-border/50 bg-background/80 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <Logo className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight">Rebid Reasons</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={toggleTheme}
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          className="flex items-center justify-center h-8 w-8 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-all duration-150"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button
          onClick={toggleRainbow}
          title="Toggle colourful mode"
          className={cn(
            "flex items-center justify-center h-8 w-8 rounded-lg transition-all duration-150",
            isRainbow
              ? "text-purple-400 hover:bg-white/[0.04]"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]",
          )}
        >
          <Palette className={cn("h-4 w-4", isRainbow && "animate-pulse")} />
        </button>
      </div>
    </header>
  );
}
