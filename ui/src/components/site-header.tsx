import { lazy, Suspense, useState } from "react";
import { Plus, Settings, Sparkles, TerminalSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useIsMobile } from "@/hooks/use-mobile";
import { useFeature } from "@/hooks/use-license";
import { useTerminal } from "@/contexts/terminal-context";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  dbxAIPage,
  openDBXAIConversation,
  useDBXAIAvailable,
  useDBXRecommendations,
} from "@/lib/dbx-ai";

import { DynamicBreadcrumb } from "./dynamic-breadcrumb";
import { LanguageToggle } from "./language-toggle";
import { ModeToggle } from "./mode-toggle";
import { Search } from "./search";

const dialogModules = import.meta.glob(["./create-resource-dialog.tsx"]);

const CreateResourceDialog = lazy(async () => {
  const module = (await dialogModules[
    "./create-resource-dialog.tsx"
  ]()) as typeof import("./create-resource-dialog");

  return {
    default: module.CreateResourceDialog,
  };
});

export function SiteHeader() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const { t } = useTranslation();
  const { openTerminal, sessions } = useTerminal();
  const location = useLocation();
  const aiPage = dbxAIPage(location.pathname);
  useDBXRecommendations(aiPage);
  const canUseDBXAI = useDBXAIAvailable();
  const [openingAI, setOpeningAI] = useState(false);
  const canUseKubectlTerminal = useFeature("terminal.kubectl");
  const hasKubectlSession = sessions.some(
    (session) => session.type === "kubectl",
  );
  const askDBXAI = async () => {
    setOpeningAI(true);
    try {
      await openDBXAIConversation(
        aiPage,
        t("siteHeader.askDBXAI", "Ask DBX AI"),
        t(
          "siteHeader.askDBXAIPrompt",
          "Analyze the current Kubernetes page and suggest the safest next actions.",
        ),
      );
    } catch {
      toast.error(t("siteHeader.dbxAIUnavailable", "DBX AI is unavailable"));
    } finally {
      setOpeningAI(false);
    }
  };
  return (
    <>
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
        <div className="flex w-full items-center gap-1 pl-2 pr-2 lg:gap-2 lg:pl-2.5 lg:pr-2.5">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <DynamicBreadcrumb />
          <div className="ml-auto flex items-center gap-2">
            <Search />
            <Plus
              className="h-5 w-5 cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => setCreateDialogOpen(true)}
              aria-label={t("siteHeader.createNewResource")}
            />
            {canUseKubectlTerminal && (
              <button
                type="button"
                onClick={() => openTerminal("button")}
                title={t("siteHeader.kubectlTerminal", "Kubectl terminal")}
                aria-label={t(
                  "siteHeader.toggleKubectlTerminal",
                  "Toggle kubectl terminal",
                )}
                className={`flex items-center justify-center rounded-sm p-1 transition-colors ${
                  hasKubectlSession
                    ? "text-green-500 hover:text-green-600"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <TerminalSquare className="h-5 w-5" />
              </button>
            )}
            {canUseDBXAI && (
              <button
                type="button"
                onClick={() => void askDBXAI()}
                disabled={openingAI}
                title={t("siteHeader.askDBXAI", "Ask DBX AI")}
                aria-label={t("siteHeader.askDBXAI", "Ask DBX AI")}
                className="flex items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <Sparkles className="h-5 w-5" />
              </button>
            )}
            {!isMobile && (
              <>
                <Separator
                  orientation="vertical"
                  className="mx-2 data-[orientation=vertical]:h-4"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => navigate("/settings")}
                  className="hidden sm:flex"
                >
                  <Settings className="h-5 w-5" />
                  <span className="sr-only">{t("siteHeader.settings")}</span>
                </Button>
                <LanguageToggle />
                <ModeToggle />
              </>
            )}
          </div>
        </div>
      </header>

      {createDialogOpen ? (
        <Suspense fallback={null}>
          <CreateResourceDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
          />
        </Suspense>
      ) : null}
    </>
  );
}
