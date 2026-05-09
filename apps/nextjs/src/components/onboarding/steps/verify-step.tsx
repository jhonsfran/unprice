import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { useQuery } from "@tanstack/react-query"
import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Label } from "@unprice/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { cn } from "@unprice/ui/utils"
import { AnimatePresence, motion } from "framer-motion"
import { Check, CheckCircle, Copy, Loader2, Shield, XCircle } from "lucide-react"
import { useState } from "react"
import { toast } from "~/lib/toast"
import { useTRPC } from "~/trpc/client"

interface VerificationResponse {
  allowed: boolean
  message?: string
  deniedReason?: string
  featureType?: string
  remaining?: number
  limit?: number
  usage?: number
  latency?: number
  error?: string
  code?: string
  statusCode?: number
}

export function VerifyStep({ className }: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, next } = useOnboarding()
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [selectedFeature, setSelectedFeature] = useState<string>("")
  const [verificationResult, setVerificationResult] = useState<VerificationResponse | null>(null)
  const [resultKey, setResultKey] = useState(0)

  const apiKey = (state?.context?.flowData as { apiKey?: string })?.apiKey || ""
  const planVersionId =
    (state?.context?.flowData as { planVersionId?: string })?.planVersionId || ""
  const projectSlug = (state?.context?.flowData as { project?: { slug: string } })?.project?.slug
  const customerId =
    (state?.context?.flowData as { customer?: { customerId: string } })?.customer?.customerId || ""

  const trpc = useTRPC()

  const { data: planVersionData, isLoading: isLoadingPlan } = useQuery(
    trpc.planVersions.getById.queryOptions(
      { id: planVersionId, projectSlug: projectSlug ?? "" },
      { enabled: !!planVersionId && !!projectSlug }
    )
  )

  const features = planVersionData?.planVersion?.planFeatures || []

  // Auto-select first feature
  if (!selectedFeature && features.length > 0) {
    setSelectedFeature(features[0]?.feature?.slug ?? "")
  }

  const curlCommand = `curl -X POST ${API_DOMAIN}v1/entitlements/verify \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customerId": "${customerId}",
    "featureSlug": "${selectedFeature}"
  }'`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(curlCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success("Copied to clipboard")
  }

  const handleVerify = async () => {
    if (!selectedFeature) {
      toast.error("Please select a feature")
      return
    }

    setIsLoading(true)

    try {
      const response = await fetch(`${API_DOMAIN}v1/entitlements/verify`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customerId,
          featureSlug: selectedFeature,
        }),
      })

      const data = await response.json()

      // Always set the result, even for non-200 responses
      if (!response.ok) {
        setVerificationResult({
          allowed: false,
          statusCode: response.status,
          ...data,
        })
        toast.error(data.message || "Request failed")
      } else {
        setVerificationResult(data)
        toast.success("Verification complete!")
      }
      setResultKey((prev) => prev + 1)
    } catch (error) {
      setVerificationResult({
        allowed: false,
        error: error instanceof Error ? error.message : "Something went wrong",
      })
      setResultKey((prev) => prev + 1)
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setIsLoading(false)
    }
  }

  if (isLoadingPlan) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (features.length === 0) {
    return (
      <div className={cn("flex max-w-lg flex-col gap-6", className)}>
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-10 items-center justify-center rounded-md bg-yellow-100">
            <Shield className="size-6 text-yellow-600" />
          </div>
          <h1 className="font-bold text-2xl">No Features</h1>
          <p className="text-center text-muted-foreground text-sm">
            The plan you created doesn't have any features to verify. You can proceed to the next
            step.
          </p>
          <Button onClick={() => next()} className="mt-4">
            Continue
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2">
        <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
          <Shield className="size-6 text-primary" />
        </div>
        <h1 className="animate-content font-bold text-2xl delay-0!">Verify Feature Access</h1>
        <div className="animate-content text-center text-muted-foreground text-sm delay-0!">
          Check if your customer has access to a specific feature.
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-4 md:flex-row md:items-start">
        <motion.div
          layout
          className="w-full max-w-md animate-content delay-200!"
          transition={{ duration: 0.3, ease: "easeInOut" }}
        >
          <Card className="h-full">
            <CardHeader>
              <CardTitle>API Request</CardTitle>
              <CardDescription>
                Run this command to verify if the customer can access a feature.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="feature">Feature</Label>
                <Select value={selectedFeature} onValueChange={setSelectedFeature}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a feature" />
                  </SelectTrigger>
                  <SelectContent>
                    {features.map((pf) => (
                      <SelectItem key={pf.id} value={pf.feature?.slug || ""}>
                        {pf.feature?.title} ({pf.feature?.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="relative rounded-md bg-slate-950 p-4 font-mono text-slate-50 text-xs">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all">{curlCommand}</pre>
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute top-2 right-2 h-8 w-8 text-slate-400 hover:text-slate-50"
                  onClick={handleCopy}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>

              <Button className="w-full" onClick={handleVerify} disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify Access"
                )}
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        <AnimatePresence mode="wait">
          {verificationResult && (
            <motion.div
              key={resultKey}
              className="w-full max-w-md"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <Card className="h-full">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    {verificationResult.allowed ? (
                      <>
                        <CheckCircle className="h-5 w-5 text-green-500" />
                        <CardTitle className="text-green-600">Access Allowed</CardTitle>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-5 w-5 text-red-500" />
                        <CardTitle className="text-red-600">
                          {verificationResult.error || verificationResult.statusCode
                            ? "Request Failed"
                            : "Access Denied"}
                        </CardTitle>
                        {verificationResult.statusCode && (
                          <span className="rounded bg-red-100 px-2 py-0.5 font-mono text-red-600 text-xs">
                            {verificationResult.statusCode}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-md bg-muted p-3">
                    <p className="mb-2 font-medium text-sm">Response:</p>
                    <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground text-xs">
                      {JSON.stringify(verificationResult, null, 2)}
                    </pre>
                  </div>

                  {verificationResult.remaining !== undefined &&
                    verificationResult.remaining !== null && (
                      <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm">
                        <span className="text-muted-foreground">Remaining Usage:</span>
                        <span className="font-medium">
                          {verificationResult.remaining}
                          {verificationResult.limit !== undefined &&
                            ` / ${verificationResult.limit}`}
                        </span>
                      </div>
                    )}

                  <Button className="w-full" onClick={() => next()}>
                    Continue
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
