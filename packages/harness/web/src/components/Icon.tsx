import {
  ArrowLeft,
  ChevronDown,
  Cloud,
  CornerLeftUp,
  ExternalLink,
  Folder,
  HelpCircle,
  History,
  type LucideIcon,
  Moon,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  TriangleAlert,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import type { JSX } from "react";

/**
 * A curated map, not a barrel import of the whole icon set — keeps the bundle
 * tree-shakeable. MacroDef.icon is still free-form config; unknown names
 * fall back to HelpCircle rather than failing to render.
 */
const ICONS: Record<string, LucideIcon> = {
  ArrowLeft,
  ChevronDown,
  Cloud,
  CornerLeftUp,
  ExternalLink,
  Folder,
  History,
  Moon,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  TriangleAlert,
  Wand2,
  X,
  Zap,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const Component = ICONS[name] ?? HelpCircle;
  return <Component size={size} strokeWidth={1.75} aria-hidden="true" />;
}
