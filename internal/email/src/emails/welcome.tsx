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

const WelcomeEmail = ({
  firstName,
}: {
  firstName: string
}) => {
  return (
    <Html lang="en" dir="ltr">
      <Tailwind>
        <Head />
        <Preview>Welcome to Unprice - authorize customer spend before paid work runs</Preview>
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
            <Section>
              <Heading className="mb-[24px] text-center font-bold text-[#ffffff] text-[28px]">
                Welcome to Unprice, {firstName}!
              </Heading>

              <Text className="mb-[24px] text-[#ffffff] text-[16px] leading-[24px]">
                Unprice is the open-source customer money path for usage-based SaaS: authorize
                customer spend before paid work runs, then explain every charge, credit, denial,
                and invoice line from the same evidence trail.
              </Text>

              <Text className="mb-[32px] text-[#ffffff] text-[16px] leading-[24px]">
                Start with one paid action. Define a plan version, install the TypeScript SDK, and
                run the decision in shadow on the built-in Sandbox—nothing blocks your traffic
                until the evidence convinces you.
              </Text>

              <Text className="mb-[24px] text-[#ffffff] text-[16px] leading-[24px]">
                When you go live, connect your own Stripe account. Unprice never sits in your funds
                flow.
              </Text>

              {/* CTA Button */}
              <Section className="mb-[32px] text-center">
                <Button
                  href="https://app.unprice.dev"
                  className="box-border rounded-[8px] bg-[#ffc53d] px-[32px] py-[16px] font-semibold text-[#111110] text-[16px] no-underline"
                >
                  Start with one paid action
                </Button>
              </Section>

              <Text className="text-center text-[#ffffff] text-[14px] leading-[20px]">
                Questions? Reply to this email—we're here to help.
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

WelcomeEmail.PreviewProps = {
  firstName: "John",
}

export default WelcomeEmail
