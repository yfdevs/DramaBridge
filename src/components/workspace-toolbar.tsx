import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";

type ToolbarContext = {
  host: HTMLDivElement | null;
  setHost: Dispatch<SetStateAction<HTMLDivElement | null>>;
};
const WorkspaceToolbarContext = createContext<ToolbarContext | null>(null);
const WorkspacePageContext = createContext(false);

export function WorkspaceToolbarProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ host, setHost }), [host]);
  return (
    <WorkspaceToolbarContext.Provider value={value}>{children}</WorkspaceToolbarContext.Provider>
  );
}

export function WorkspaceActionHost() {
  const context = useContext(WorkspaceToolbarContext);
  return <div ref={context?.setHost} className="ml-auto flex shrink-0 items-center empty:hidden" />;
}

export function WorkspacePageActivity({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <WorkspacePageContext.Provider value={active}>{children}</WorkspacePageContext.Provider>;
}

export function WorkspaceActions({ label, children }: { label: string; children: ReactNode }) {
  const context = useContext(WorkspaceToolbarContext);
  const active = useContext(WorkspacePageContext);
  if (!active || !context?.host) return null;
  return createPortal(
    <div role="toolbar" aria-label={label} className="flex items-center gap-2">
      {children}
    </div>,
    context.host,
  );
}

export function useWorkspacePageActive() {
  return useContext(WorkspacePageContext);
}
