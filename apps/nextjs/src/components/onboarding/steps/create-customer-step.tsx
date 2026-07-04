import { type StepComponentProps, useOnboarding } from "@onboardjs/react"
import { API_DOMAIN } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { cn } from "@unprice/ui/utils"
import { AnimatePresence, motion } from "framer-motion"
import { Check, CheckCircle, Copy, Loader2, UserPlus, XCircle } from "lucide-react"
import { useState } from "react"
import { toast } from "~/lib/toast"

interface CustomerSignUpResponse {
  customerId?: string
  email?: string
  name?: string
  checkoutUrl?: string
  message?: string
  error?: string
  code?: string
  statusCode?: number
}

export function CreateCustomerStep({
  className,
}: React.ComponentProps<"div"> & StepComponentProps) {
  const { state, next, updateContext } = useOnboarding()
  const [isLoading, setIsLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [customerResult, setCustomerResult] = useState<CustomerSignUpResponse | null>(null)
  const [resultKey, setResultKey] = useState(0)

  const apiKey = (state?.context?.flowData as { apiKey?: string })?.apiKey || ""
  const planVersionId =
    (state?.context?.flowData as { planVersionId?: string })?.planVersionId || ""

  const [formData, setFormData] = useState({
    name: "Onboarding User",
    email: "onboarding@example.com",
  })

  const successUrl = "http://localhost:3000/success"
  const cancelUrl = "http://localhost:3000/cancel"

  const curlCommand = `curl -X POST ${API_DOMAIN}v1/customer/signUp \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "${formData.name}",
    "email": "${formData.email}",
    "planVersionId": "${planVersionId}",
    "successUrl": "${successUrl}",
    "cancelUrl": "${cancelUrl}"
  }'`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(curlCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success("Copied to clipboard")
  }

  const handleCreateCustomer = async () => {
    setIsLoading(true)

    try {
      const response = await fetch(`${API_DOMAIN}v1/customer/signUp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          planVersionId,
          successUrl,
          cancelUrl,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setCustomerResult({
          statusCode: response.status,
          ...data,
        })
        toast.error(data.message || "Request failed")
      } else {
        setCustomerResult(data)
        await updateContext({
          flowData: {
            customer: data,
          },
        })
        toast.success("Customer created successfully!")
      }
      setResultKey((prev) => prev + 1)
    } catch (error) {
      setCustomerResult({
        error: error instanceof Error ? error.message : "Something went wrong",
      })
      setResultKey((prev) => prev + 1)
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setIsLoading(false)
    }
  }

  const isSuccess =
    customerResult &&
    !customerResult.error &&
    !customerResult.statusCode &&
    customerResult.customerId

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <div className="flex flex-col items-center gap-2">
        <div className="flex size-10 animate-content items-center justify-center rounded-md bg-primary/10 delay-0!">
          <UserPlus className="size-6 text-primary" />
        </div>
        <h1 className="animate-content font-bold text-2xl delay-0!">Create your first Customer</h1>
        <div className="animate-content text-center text-muted-foreground text-sm delay-0!">
          Now that you have a plan, let's create a customer subscribed to it.
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
                Run this command in your terminal to create a customer.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
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

              <Button className="w-full" onClick={handleCreateCustomer} disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Customer"
                )}
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        <AnimatePresence mode="wait">
          {customerResult && (
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
                    {isSuccess ? (
                      <>
                        <CheckCircle className="h-5 w-5 text-green-500" />
                        <CardTitle className="text-green-600">Customer Created</CardTitle>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-5 w-5 text-red-500" />
                        <CardTitle className="text-red-600">Request Failed</CardTitle>
                        {customerResult.statusCode && (
                          <span className="rounded bg-red-100 px-2 py-0.5 font-mono text-red-600 text-xs">
                            {customerResult.statusCode}
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
                      {JSON.stringify(customerResult, null, 2)}
                    </pre>
                  </div>

                  <Button
                    className="w-full"
                    onClick={async () => {
                      await next()
                    }}
                  >
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
