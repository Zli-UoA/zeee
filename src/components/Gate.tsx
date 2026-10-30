import { Button, LayerCard, Text } from '@cloudflare/kumo';
import { ArrowRightIcon } from '@phosphor-icons/react';

type Props = {
  code: string;
  title: string;
  description: string;
  action: { href: string; label: string };
};

export function Gate({ code, title, description, action }: Props) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 py-16">
      <Text variant="mono-secondary">{code}</Text>
      <LayerCard className="p-6">
        <div className="flex flex-col gap-3">
          <Text variant="heading" size="lg" as="h1">
            {title}
          </Text>
          <Text variant="secondary" as="p">
            {description}
          </Text>
          <form method="get" action={action.href} className="pt-2">
            <Button
              type="submit"
              variant="primary"
              icon={<ArrowRightIcon size={14} />}
              className="w-full"
            >
              {action.label}
            </Button>
          </form>
        </div>
      </LayerCard>
    </div>
  );
}
