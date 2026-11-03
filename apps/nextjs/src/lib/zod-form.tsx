import { zodResolver } from "@hookform/resolvers/zod"
import type { FieldValues, UseFormProps } from "react-hook-form"
import { useForm } from "react-hook-form"
import { z } from "zod"

export function useZodForm<TSchema extends z.ZodType<FieldValues>>(
  props: Omit<UseFormProps<z.output<TSchema>, unknown, z.output<TSchema>>, "resolver"> & {
    schema: TSchema
  }
) {
  // Form state uses normalized values; validation still receives every raw value unchanged.
  const formSchema = z.preprocess((values: z.output<TSchema>) => values, props.schema)
  const form = useForm<z.output<TSchema>, unknown, z.output<TSchema>>({
    ...props,
    shouldFocusError: true,
    delayError: 100,
    resolver: zodResolver(formSchema),
  })

  return form
}
