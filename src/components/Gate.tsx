import { LayerCard, LinkButton, Text } from '@cloudflare/kumo';
import { ArrowRightIcon } from '@phosphor-icons/react';

type Props = {
  title: string;
  description: string;
  action: { href: string; label: string };
};

export function Gate({ title, description, action }: Props) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center py-10">
      <LayerCard className="px-6 py-5 sm:px-8 sm:py-7">
        <div className="flex flex-col gap-3">
          <Text variant="heading" size="lg" as="h1" DANGEROUS_className="text-balance">
            {title}
          </Text>
          <Text variant="secondary" as="p">
            {description}
          </Text>
          <LinkButton
            href={action.href}
            variant="primary"
            icon={<ArrowRightIcon size={14} />}
            className="mt-3 w-full"
          >
            {action.label}
          </LinkButton>
        </div>
      </LayerCard>
    </div>
  );
}
