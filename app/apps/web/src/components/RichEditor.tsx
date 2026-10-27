import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Button, Divider, Space, Tooltip } from 'antd';
import { tokens } from '../theme';
import {
  AlignCenterOutlined,
  AlignLeftOutlined,
  AlignRightOutlined,
  BoldOutlined,
  ClearOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';

export interface RichEditorHandle {
  insert: (text: string) => void;
  focus: () => void;
}

/**
 * 轻量富文本编辑器。
 *
 * 刻意不用 Quill / wangEditor 这类编辑器：
 * 它们产出带 class 和外部 <style> 的 HTML，而绝大多数邮件客户端会丢掉 <style> 和 class，
 * 发出去排版就散了。execCommand 产出的内联标签虽然朴素，但在邮件里反而更可靠。
 */
const RichEditor = forwardRef<RichEditorHandle, { value: string; onChange: (html: string) => void }>(
  function RichEditor({ value, onChange }, ref) {
    const boxRef = useRef<HTMLDivElement>(null);
    const lastEmitted = useRef(value);

    useEffect(() => {
      if (!boxRef.current) return;
      // 只在外部值真的变了时才写回 DOM，否则每次输入都会重置光标
      if (value !== lastEmitted.current) {
        boxRef.current.innerHTML = value;
        lastEmitted.current = value;
      }
    }, [value]);

    const emit = () => {
      const html = boxRef.current?.innerHTML ?? '';
      lastEmitted.current = html;
      onChange(html);
    };

    const exec = (command: string, arg?: string) => {
      boxRef.current?.focus();
      document.execCommand(command, false, arg);
      emit();
    };

    useImperativeHandle(ref, () => ({
      insert: (text: string) => {
        boxRef.current?.focus();
        document.execCommand('insertText', false, text);
        emit();
      },
      focus: () => boxRef.current?.focus(),
    }));

    const insertLink = () => {
      const url = window.prompt('链接地址（完整 URL，例如 https://example.com）');
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) {
        window.alert('请填写以 http:// 或 https:// 开头的完整地址');
        return;
      }
      exec('createLink', url);
    };

    const insertImage = () => {
      const url = window.prompt('图片地址（必须是公网可访问的 URL，邮件里不能引用本地图片）');
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) {
        window.alert('请填写以 http:// 或 https:// 开头的完整地址');
        return;
      }
      exec('insertImage', url);
    };

    return (
      <div style={{ border: '1px solid #d9d9d9', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '6px 8px', borderBottom: `1px solid ${tokens.border}`, background: tokens.secondary }}>
          <Space size={2} wrap split={<Divider type="vertical" />}>
            <Tooltip title="加粗">
              <Button size="small" type="text" icon={<BoldOutlined />} onClick={() => exec('bold')} />
            </Tooltip>
            <Tooltip title="斜体">
              <Button size="small" type="text" icon={<ItalicOutlined />} onClick={() => exec('italic')} />
            </Tooltip>
            <Tooltip title="下划线">
              <Button size="small" type="text" icon={<UnderlineOutlined />} onClick={() => exec('underline')} />
            </Tooltip>
            <Tooltip title="删除线">
              <Button
                size="small"
                type="text"
                icon={<StrikethroughOutlined />}
                onClick={() => exec('strikeThrough')}
              />
            </Tooltip>
            <Button size="small" type="text" onClick={() => exec('formatBlock', '<h2>')}>
              大标题
            </Button>
            <Button size="small" type="text" onClick={() => exec('formatBlock', '<p>')}>
              正文
            </Button>
            <Tooltip title="无序列表">
              <Button
                size="small"
                type="text"
                icon={<UnorderedListOutlined />}
                onClick={() => exec('insertUnorderedList')}
              />
            </Tooltip>
            <Tooltip title="有序列表">
              <Button
                size="small"
                type="text"
                icon={<OrderedListOutlined />}
                onClick={() => exec('insertOrderedList')}
              />
            </Tooltip>
            <Tooltip title="插入链接">
              <Button size="small" type="text" icon={<LinkOutlined />} onClick={insertLink} />
            </Tooltip>
            <Tooltip title="插入图片（公网 URL）">
              <Button size="small" type="text" icon={<PictureOutlined />} onClick={insertImage} />
            </Tooltip>
            <Tooltip title="左对齐">
              <Button size="small" type="text" icon={<AlignLeftOutlined />} onClick={() => exec('justifyLeft')} />
            </Tooltip>
            <Tooltip title="居中">
              <Button size="small" type="text" icon={<AlignCenterOutlined />} onClick={() => exec('justifyCenter')} />
            </Tooltip>
            <Tooltip title="右对齐">
              <Button size="small" type="text" icon={<AlignRightOutlined />} onClick={() => exec('justifyRight')} />
            </Tooltip>
            <Tooltip title="清除格式">
              <Button
                size="small"
                type="text"
                icon={<ClearOutlined />}
                onClick={() => exec('removeFormat')}
              />
            </Tooltip>
          </Space>
        </div>

        <div
          ref={boxRef}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onBlur={emit}
          onPaste={(e) => {
            // 从 Word / 网页粘贴会带一堆 mso-* 样式和 <style>，是邮件排版崩掉的头号原因。
            // 这里只取纯文本，让用户用工具栏重新排版。
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
            emit();
          }}
          style={{
            minHeight: 320,
            maxHeight: 520,
            overflow: 'auto',
            padding: 14,
            fontSize: 14,
            lineHeight: 1.7,
            outline: 'none',
          }}
        />
      </div>
    );
  },
);

export default RichEditor;
