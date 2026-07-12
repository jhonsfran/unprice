"use client"

import { AUTH_ROUTES } from "@unprice/config"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { z } from "zod"
import { signUpWithCredentials } from "~/actions/signupCredentials"
import { type SignupIntent, buildAuthHref } from "~/lib/signup-funnel"
import { useZodForm } from "~/lib/zod-form"

export const SignupSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(6),
    confirmPassword: z.string().min(6),
    name: z.string().min(3),
    sessionId: z.string().optional(),
    next: z.string().optional(),
    intent: z.enum(["paid-action"]).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  })

export function SignUpCredentials({
  className,
  sessionId,
  next,
  intent,
}: { className?: string; sessionId?: string; next?: string; intent?: SignupIntent }) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const form = useZodForm({
    schema: SignupSchema,
    defaultValues: {
      email: "",
      password: "",
      name: "",
      confirmPassword: "",
      sessionId,
      next,
      intent,
    },
    reValidateMode: "onSubmit",
  })

  const onSubmit = async (data: z.infer<typeof SignupSchema>) => {
    setIsLoading(true)
    const res = await signUpWithCredentials(data)

    if (!res.success) {
      form.setError("root", { message: res.message })
      setIsLoading(false)
      return
    }

    if (res.redirect) {
      router.push(
        buildAuthHref(AUTH_ROUTES.SIGNIN, {
          sessionId: data.sessionId,
          intent: data.intent,
          next: data.next,
        })
      )
      setIsLoading(false)
      return
    }
  }

  return (
    <Form {...form}>
      <form className={cn("w-full", className)} onSubmit={form.handleSubmit(onSubmit)}>
        <motion.div
          className="flex items-center justify-center px-1 py-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {form.formState.errors.root && (
            <p className="w-full self-center text-center text-red-500">
              {form.formState.errors.root.message}
            </p>
          )}
        </motion.div>
        <div className="grid gap-3">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="John Doe" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="m@example.com" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input {...field} type="password" placeholder="********" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm Password</FormLabel>
                <FormControl>
                  <Input {...field} type="password" placeholder="********" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="mt-2 w-full" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
            Sign up
          </Button>
        </div>
      </form>
    </Form>
  )
}
