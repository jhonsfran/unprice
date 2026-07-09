"use client"

import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import { Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { z } from "zod"
import { loginWithCredentials } from "~/actions/loginCredentials"
import { useZodForm } from "~/lib/zod-form"

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

export function SignInCredentials({
  className,
  redirectTo,
  isLastUsed,
}: { className?: string; redirectTo?: string; isLastUsed?: boolean }) {
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()
  const form = useZodForm({
    schema: LoginSchema,
    defaultValues: {
      email: "",
      password: "",
    },
    reValidateMode: "onSubmit",
  })

  const onSubmit = async (data: z.infer<typeof LoginSchema>) => {
    setIsLoading(true)
    const res = await loginWithCredentials({ ...data, redirectTo })

    if (!res.success) {
      form.setError("root", { message: res.message })
      setIsLoading(false)
      return
    }

    if (res.redirect) {
      router.push(res.redirect)
      setIsLoading(false)
      return
    }
  }

  return (
    <div className="relative w-full">
      {isLastUsed && (
        <Badge
          variant="secondary"
          className="-translate-y-1/2 absolute top-1/2 right-3 z-10 h-5 whitespace-nowrap px-2 text-[10px]"
        >
          Last used
        </Badge>
      )}
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
            <Button type="submit" className="mt-2 w-full" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              Login
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
