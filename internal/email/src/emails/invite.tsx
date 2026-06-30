import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"

const InviteEmail = (props: {
  inviterName: string
  inviteeName: string
  workspaceName: string
}) => {
  const { inviterName, inviteeName, workspaceName } = props

  return (
    <Html lang="en" dir="ltr">
      <Tailwind>
        <Head />
        <Preview>You've been invited to join {workspaceName} on Unprice</Preview>
        <Body className="bg-[#191918] py-[40px] font-sans">
          <Container className="mx-auto max-w-[600px] rounded-[8px] bg-[#111110] px-[32px] py-[40px]">
            {/* Logo */}
            <Section className="mb-[32px] text-center">
              <Img
                src="https://di867tnz6fwga.cloudfront.net/brand-kits/4eeedaec-95df-435b-a811-9054368784f0/primary/1f533c45-269c-4546-b4d3-ef7ae78c420a.png"
                alt="Unprice"
                className="mx-auto h-auto w-full max-w-[200px]"
              />
            </Section>

            {/* Main Content */}
            <Section className="mb-[40px] text-center">
              <Heading className="m-0 mb-[32px] font-bold text-[28px] text-white leading-[1.2]">
                You're invited to join {workspaceName}
              </Heading>

              <Text className="m-0 mb-[32px] text-[#a1a1aa] text-[16px] leading-[1.5]">
                {inviterName} has invited you to collaborate on {workspaceName} on Unprice —
                open-source PriceOps infrastructure for usage-based SaaS.
              </Text>

              <Text className="m-0 mb-[32px] text-[18px] text-white">Hello {inviteeName},</Text>

              <Text className="m-0 mb-[32px] text-[#a1a1aa] text-[16px] leading-[1.6]">
                Join your team to meter usage, enforce entitlements, budget expensive runs, and
                explain every invoice from one inspectable money path.
              </Text>
            </Section>

            {/* CTA Button */}
            <Section className="mb-[32px] text-center">
              <Button
                href={"https://app.unprice.dev/auth/signin"}
                className="box-border inline-block rounded-[12px] bg-[#ffc53d] px-[32px] py-[16px] font-semibold text-[16px] text-black no-underline"
              >
                Accept Invitation
              </Button>
            </Section>

            {/* Alternative Link */}
            <Section className="mb-[40px] text-center">
              <Text className="m-0 mb-[8px] text-[#a1a1aa] text-[14px]">
                Or copy and paste this link into your browser:
              </Text>
              <Link
                href={"https://app.unprice.dev"}
                className="break-all text-[#ffc53d] text-[14px] underline"
              >
                https://app.unprice.dev
              </Link>
            </Section>

            {/* Divider */}
            <Section className="mt-[40px] border-[#333333] border-t pt-[32px]">
              <Text className="m-0 mb-[16px] text-center text-[#666666] text-[14px] leading-[1.5]">
                This invitation was sent by {inviterName}. If you don't want to join this team, you
                can safely ignore this email.
              </Text>
            </Section>

            {/* Footer */}
            <Hr className="my-[32px] border-[#333333]" />

            <Section>
              <Row>
                <Column className="text-center" align="center">
                  <Link href="https://github.com/jhonsfran1165/unprice" className="inline-block">
                    <Img
                      src="https://new.email/static/emails/social/social-github.png"
                      alt="GitHub"
                      className="h-[40px] w-[40px]"
                    />
                  </Link>
                </Column>
              </Row>
              <Text className="mt-[16px] mb-[8px] text-center text-[#ffffff] text-[12px] leading-[16px]">
                <Link href="https://unprice.dev" className="text-[#ffc53d] no-underline">
                  unprice.dev
                </Link>
              </Text>

              <Text className="mb-[8px] text-center text-[#ffffff] text-[12px] leading-[16px]">
                Berlin, Germany &nbsp;&middot;&nbsp;
                <Link
                  href="https://unprice.dev/unsubscribe"
                  className="text-[#ffc53d] no-underline"
                >
                  Unsubscribe
                </Link>
              </Text>

              <Text className="m-0 text-center text-[#ffffff] text-[12px] leading-[16px]">
                © 2026 Unprice, Inc.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

InviteEmail.PreviewProps = {
  inviterName: "Sarah Johnson",
  inviteeName: "Alex Chen",
  workspaceName: "Product Team",
}

export default InviteEmail
