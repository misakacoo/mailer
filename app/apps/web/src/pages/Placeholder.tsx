import { Card, Empty, Tag } from 'antd';
import PageHeader from '../components/PageHeader';
import Section from '../components/Section';
import { tokens } from '../theme';

export default function Placeholder({
  title,
  layer,
  desc,
}: {
  title: string;
  layer: string;
  desc: string;
}) {
  return (
    <div className="page">
      <PageHeader title={title} extra={<Tag>{layer}</Tag>} />
      <Section title="尚未开发">
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ fontSize: 13, color: tokens.muted }}>{desc}</span>}
            style={{ padding: '40px 0', margin: 0 }}
          />
        </Card>
      </Section>
    </div>
  );
}
