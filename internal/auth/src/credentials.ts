import { verifyPassword } from "./password"

const CREDENTIALS_DECOY_PASSWORD_HASH =
  "pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$f2Tpn681FBg4tL6UX653B4WEnFBCNeUTwmuGcCbJzak"

type CredentialsUser = {
  email: string
  id: string
  image: string | null
  name: string | null
  password: string | null
}

export function toCredentialsAuthUser(user: CredentialsUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
  }
}

export async function verifyCredentialsPassword({
  password,
  passwordHash,
}: {
  password: string
  passwordHash: string | null | undefined
}): Promise<boolean> {
  const validPassword = await verifyPassword(
    password,
    passwordHash ?? CREDENTIALS_DECOY_PASSWORD_HASH
  )

  return Boolean(passwordHash && validPassword)
}
