import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import QRCode from "qrcode"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Switch } from "@workspace/ui/components/switch"
import { Label } from "@workspace/ui/components/label"
import {
  CheckCircle2Icon,
  Loader2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { toast } from "sonner"
import { getSessionStatus, connectSession, pairSession } from "../hooks/use-sessions"
import { useRealtimeEvent } from "@/features/realtime/hooks/use-realtime-event"

export function QrConnectDialog({
  sessionId,
  sessionLabel,
  open,
  isConnected = false,
  onOpenChange,
  onConnected,
}: {
  sessionId: string
  sessionLabel: string
  open: boolean
  // Already-linked number ("View integration"): show the sync options it
  // was linked with as read-only -- they only apply at pairing time, so
  // changing them here would do nothing (and Continue would reconnect).
  isConnected?: boolean
  onOpenChange: (open: boolean) => void
  onConnected: () => void
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const startedRef = useRef(false)
  const connectedRef = useRef(false)
  const queryClient = useQueryClient()

  // This business-specific connection must start clean: never import the
  // phone's existing chats, contacts, or group participants. Only new
  // private customer messages received after linking may enter the CRM.
  const [step, setStep] = useState<"options" | "connecting">("options")
  const [syncHistory, setSyncHistory] = useState(false)
  const [syncGroupMembers, setSyncGroupMembers] = useState(false)
  const [pairingMode, setPairingMode] = useState(true)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const pairingRequestedRef = useRef(false)

  const { data, error } = useQuery({
    queryKey: ["session-status", sessionId],
    queryFn: () => getSessionStatus({ data: { sessionId } }),
    enabled: open && (step === "connecting" || isConnected),
  })

  // No polling: the session's WebSocket pushes a `session-status` event on
  // every QR rotation, on connect and on disconnect -- each one triggers a
  // single status read (which carries the fresh QR string). `socket-open`
  // covers a QR that was issued before this session's socket came up.
  useRealtimeEvent((event) => {
    if (!open || step !== "connecting") return
    if (event.sessionId !== sessionId) return
    if (event.type === "session-status" || event.type === "socket-open") {
      queryClient.invalidateQueries({
        queryKey: ["session-status", sessionId],
      })
    }
  })

  // Reset local state whenever the dialog closes, so reopening starts
  // clean at the options step again.
  const disconnectedSinceRef = useRef<number | null>(null)
  const preparingSinceRef = useRef<number | null>(null)
  useEffect(() => {
    if (open) return
    startedRef.current = false
    connectedRef.current = false
    disconnectedSinceRef.current = null
    preparingSinceRef.current = null
    setQrDataUrl(null)
    setStep("options")
    setSyncHistory(false)
    setSyncGroupMembers(false)
    setPairingMode(true)
    setPairingCode(null)
    setPairingError(null)
    pairingRequestedRef.current = false
    // Drop the cached status too: useQuery hands back cached data even
    // while disabled, so a stale "connected" from a previous run would
    // trip the auto-close effect below the moment the dialog reopens.
    queryClient.removeQueries({ queryKey: ["session-status", sessionId] })
  }, [open, queryClient, sessionId])

  // Tick while the dialog is open so the "stuck preparing" check below
  // re-evaluates without waiting on the next status poll.
  useEffect(() => {
    if (!open || step !== "connecting") return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open, step])

  function startConnecting() {
    if (startedRef.current) return
    startedRef.current = true
    pairingRequestedRef.current = false
    setPairingCode(null)
    setPairingError(null)
    preparingSinceRef.current = Date.now()
    setStep("connecting")
    connectSession({
      data: { sessionId, syncHistory, syncGroupMembers },
    }).catch(() =>
      toast.error("Couldn't start the connection. Please try again.")
    )
  }

  // In pairing-code mode, wait for Baileys' QR/ready event before asking
  // for the code. Never request it immediately after makeWASocket().
  useEffect(() => {
    if (!open || step !== "connecting" || !pairingMode) return
    if (data?.connection !== "qr" || pairingRequestedRef.current) return
    pairingRequestedRef.current = true
    pairSession({
      data: { sessionId, phone: "5358503073" },
    })
      .then((result: any) => {
        if (typeof result?.code === "string") setPairingCode(result.code)
        else setPairingError("No se recibió un código de vinculación.")
      })
      .catch((err: unknown) => {
        setPairingError(err instanceof Error ? err.message : "No se pudo generar el código.")
      })
  }, [open, step, pairingMode, data?.connection, sessionId])

  useEffect(() => {
    if (pairingMode || !data?.qr) {
      setQrDataUrl(null)
      return
    }
    preparingSinceRef.current = null
    QRCode.toDataURL(data.qr, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
  }, [data?.qr, pairingMode])

  useEffect(() => {
    // Only auto-close when a connection attempt started in THIS dialog
    // session finishes -- never on open (e.g. "View integration" on an
    // already-connected number with a cached "connected" status).
    if (step !== "connecting" || !startedRef.current) return
    if (data?.connection !== "connected" || connectedRef.current) return
    connectedRef.current = true
    // Small delay so the worker's D1 write (markSessionStatus) has time to
    // land before we invalidate the sessions query — without this the
    // session card would briefly show "Not connected" on a stale read.
    const timer = setTimeout(() => {
      onConnected()
      onOpenChange(false)
    }, 600)
    return () => clearTimeout(timer)
  }, [step, data?.connection, onConnected, onOpenChange])

  function handleRetry() {
    startedRef.current = false
    connectedRef.current = false
    disconnectedSinceRef.current = null
    preparingSinceRef.current = null
    setQrDataUrl(null)
    setPairingCode(null)
    setPairingError(null)
    pairingRequestedRef.current = false
    queryClient.removeQueries({ queryKey: ["session-status", sessionId] })
    startedRef.current = true
    setStep("connecting")
    connectSession({
      data: { sessionId, syncHistory, syncGroupMembers, force: true },
    }).catch(() =>
      toast.error("Couldn't start the connection. Please try again.")
    )
  }

  const connection = data?.connection ?? "connecting"

  // The worker reports "idle" both before a connection attempt has started
  // and momentarily right after POST /connect (it flips to "connecting"
  // only once the async startSocket() work actually begins) -- it's a
  // loading state, not a failure, so it must not trip isFailed.
  //
  // "disconnected" is trickier: the worker also parks in "disconnected" for
  // ~3s during its own automatic reconnect before retrying startSocket().
  // A status poll landing in that window would otherwise flash a false
  // "Connection failed" mid-retry. Debounce it past that retry window so
  // only a disconnect that actually sticks counts as a real failure.
  if (connection !== "disconnected") {
    disconnectedSinceRef.current = null
  } else if (disconnectedSinceRef.current === null) {
    disconnectedSinceRef.current = Date.now()
  }

  // "Preparing your connection…" is the spinner shown until a QR arrives.
  // If pairing dies server-side before any QR is issued (e.g. WhatsApp
  // rejecting the registration payload), the status can sit on
  // "connecting"/"idle" with no qr for a long time — time-box it so the
  // user gets a Retry instead of an infinite spinner.
  if (!qrDataUrl && connection !== "connected" && !isDisconnectedLong()) {
    if (preparingSinceRef.current === null) preparingSinceRef.current = now
  } else {
    preparingSinceRef.current = null
  }
  const preparingTooLong =
    !pairingCode && !pairingError && preparingSinceRef.current !== null &&
    now - preparingSinceRef.current > 15_000

  function isDisconnectedLong() {
    return (
      connection === "disconnected" &&
      disconnectedSinceRef.current !== null &&
      Date.now() - disconnectedSinceRef.current > 4000
    )
  }

  const isFailed = Boolean(error) || Boolean(pairingError) || isDisconnectedLong() || preparingTooLong

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {isConnected ? sessionLabel : `Connect ${sessionLabel}`}
          </SheetTitle>
          <SheetDescription>
            {isConnected
              ? "This number is linked and syncing."
              : pairingMode
              ? "Vincula el número de prueba introduciendo el código de ocho dígitos en WhatsApp."
              : "Scan this code with WhatsApp to link the number."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-6 pb-6">
          {isConnected && step === "options" ? (
            <div className="flex w-full flex-col gap-4">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2Icon className="size-4 text-primary" />
                <span className="font-medium">Connected</span>
                {data?.user && (
                  <span className="text-muted-foreground">
                    {data.user.split(":")[0]}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="sync-history-ro"
                  className="text-sm font-medium"
                >
                  Import chat history
                </Label>
                <Switch
                  id="sync-history-ro"
                  checked={data?.syncHistory ?? false}
                  disabled
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label
                  htmlFor="sync-group-members-ro"
                  className="text-sm font-medium"
                >
                  Sync group members
                </Label>
                <Switch
                  id="sync-group-members-ro"
                  checked={data?.syncGroupMembers ?? false}
                  disabled
                />
              </div>
              <p className="text-xs text-muted-foreground">
                These were set when the number was linked and only apply at
                pairing time. To change them, delete this integration and
                connect the number again.
              </p>
            </div>
          ) : step === "options" ? (
            <div className="flex w-full flex-col gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="sync-history" className="text-sm font-medium">
                    Importar conversaciones anteriores
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Desactivado por privacidad. Solo se registrarán los mensajes nuevos de clientes que escriban a la tienda.
                  </p>
                </div>
                <Switch
                  id="sync-history"
                  checked={false}
                  disabled
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-sm font-medium">Método de vinculación</Label>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant={pairingMode ? "default" : "outline"} onClick={() => setPairingMode(true)}>
                    Código de 8 dígitos
                  </Button>
                  <Button type="button" size="sm" variant={!pairingMode ? "default" : "outline"} onClick={() => setPairingMode(false)}>
                    Código QR
                  </Button>
                </div>
                {pairingMode && (
                  <p className="text-xs text-muted-foreground">
                    Se utilizará exclusivamente el número de prueba autorizado, no el WhatsApp comercial.
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label
                    htmlFor="sync-group-members"
                    className="text-sm font-medium"
                  >
                    Importar participantes de grupos
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Desactivado por privacidad. El asistente no importa contactos ni participantes de grupos.
                  </p>
                </div>
                <Switch
                  id="sync-group-members"
                  checked={false}
                  disabled
                />
              </div>
              <Button onClick={startConnecting} className="mt-2">
                Continue
              </Button>
            </div>
          ) : connection === "connected" ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCircle2Icon className="size-7" />
              </div>
              <div>
                <p className="text-sm font-medium">Connected</p>
                {data?.user && (
                  <p className="text-xs text-muted-foreground">
                    {data.user.split(":")[0]}
                  </p>
                )}
              </div>
            </div>
          ) : isFailed ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertCircleIcon className="size-7" />
              </div>
              <div>
                <p className="text-sm font-medium">Connection failed</p>
                <p className="text-xs text-muted-foreground">
                  {pairingError || (error
                    ? "Could not reach the WhatsApp service. Check your network and try again."
                    : "WhatsApp closed the connection before a pairing method was ready. This can happen from network issues or a rejected pairing request.")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleRetry}>
                <RefreshCwIcon />
                Retry connection
              </Button>
            </div>
          ) : pairingMode && pairingCode ? (
            <div className="flex w-full flex-col items-center gap-4 py-8 text-center">
              <CheckCircle2Icon className="size-8 text-primary" />
              <p className="text-sm font-medium">Código de vinculación</p>
              <p className="rounded-lg border bg-muted px-5 py-4 font-mono text-2xl font-bold tracking-[0.25em]">
                {pairingCode}
              </p>
              <ol className="w-full list-decimal space-y-2 ps-5 text-left text-sm text-muted-foreground">
                <li>Abre WhatsApp en el número de prueba.</li>
                <li>Entra en Dispositivos vinculados.</li>
                <li>Pulsa Vincular un dispositivo y elige Vincular con número de teléfono.</li>
                <li>Introduce el código mostrado arriba.</li>
              </ol>
              <p className="text-xs text-muted-foreground">No compartas este código con nadie. Es válido solo para completar esta vinculación.</p>
            </div>
          ) : pairingMode && data?.connection === "qr" && !pairingError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Solicitando el código de vinculación…</p>
            </div>
          ) : qrDataUrl ? (
            <>
              <div className="overflow-hidden rounded-xl border bg-white p-3">
                <img
                  src={qrDataUrl}
                  alt="WhatsApp QR code"
                  width={220}
                  height={220}
                />
              </div>
              <ol className="w-full list-decimal space-y-1 ps-4 text-xs text-muted-foreground">
                <li>Open WhatsApp on your phone</li>
                <li>Go to Settings → Linked Devices</li>
                <li>Tap "Link a Device" and scan this code</li>
              </ol>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
                Waiting for scan…
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Preparing your connection…
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
