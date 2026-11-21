import { AccountSelection } from "@/pages/shared/account-selection";
import { PinduoduoUploadProgressCard } from "./upload-progress";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import {
  type PinduoduoDramaServiceStatus,
  type PinduoduoDramaAccount,
  pinduoduoDramaService,
} from "@/platforms/pinduoduo-drama/service";

const initialStatus: PinduoduoDramaServiceStatus = {
  platform: "pinduoduo-drama",
  running: false,
  loginState: "unknown",
  manageUrl: "https://mcn.pinduoduo.com/home/shortplayManage",
  loginExpiredUrl: "https://mcn.pinduoduo.com/register",
  userDataDir: "",
  pid: null,
};

function successMessage(status: PinduoduoDramaServiceStatus) {
  return status.running ? "拼多多短剧已启动" : "拼多多短剧已停止";
}

export function PinduoduoDramaServiceControlPage() {
  const [accounts, setAccounts] = useState<PinduoduoDramaAccount[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const service = useMemo(() => ({ ...pinduoduoDramaService, start: () => pinduoduoDramaService.start(selectedIds) }), [selectedIds]);
  const { loading, pendingAction, status, toggleService } = useServiceControl({
    initialStatus,
    service,
    successMessage,
  });

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError("");
    try {
      const result = await pinduoduoDramaService.listAccounts();
      setAccounts(result.accounts);
      setSelectedIds(result.selectedAccountIds.filter(id => result.accounts.some(account => account.accountId === id)));
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountsLoading(false);
    }
  }, []);
  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  return (
      <ServiceControlButtonPage

        loading={loading}
        pendingAction={pendingAction}
        running={status.running}
        startDisabled={accountsLoading || !!accountsError || selectedIds.length === 0}
        onToggle={() => void toggleService()}
        beforeBrowserInstances={
          <>
          <PinduoduoUploadProgressCard status={status} />
          <AccountSelection
            locked={loading || status.running}
            runtimes={(status.instances ?? []).map(instance => ({ accountId: instance.id, launched: instance.launched, loginState: instance.loginState }))}
            selection={{ accounts, selected: selectedIds, setSelected: setSelectedIds, fetching: accountsLoading, error: accountsError, refresh: loadAccounts }}
          />
          {Object.entries(status.accountErrors ?? {}).map(([name, error]) => (
            <p key={name} role="status" className="text-sm text-destructive">{name}：{error}</p>
          ))}
          </>
        }
      />
  );
}
