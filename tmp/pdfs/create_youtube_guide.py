from pathlib import Path
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader

root = Path(__file__).resolve().parents[2]
out = root / 'output/pdf/youtube-cms-content-id-guide.pdf'
out.parent.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('Harmony', str(root / 'src/assets/fonts/harmonyos-sans/HarmonyOS_Sans_SC.ttf')))
styles = {
    'title': ParagraphStyle('title', fontName='Harmony', fontSize=23, leading=33, textColor=colors.HexColor('#152D46'), spaceAfter=15),
    'h': ParagraphStyle('h', fontName='Harmony', fontSize=15, leading=23, textColor=colors.HexColor('#152D46'), spaceBefore=15, spaceAfter=8),
    'p': ParagraphStyle('p', fontName='Harmony', fontSize=10.5, leading=18, spaceAfter=8, wordWrap='CJK'),
    'note': ParagraphStyle('note', fontName='Harmony', fontSize=10, leading=17, textColor=colors.HexColor('#475569'), spaceAfter=10, wordWrap='CJK'),
}
story = []
links = []
def p(text, kind='p'):
    story.append(Paragraph(text, styles[kind]))
def link(label, url):
    links.append(url)
    p(f'<link href="{url}" color="#1266B3"><u>{label}（点击打开）</u></link>', 'note')

p('YouTube CMS 与 Content ID<br/>开通及程序授权教程', 'title')
p('适用：DramaBridge 的默认权利管理设置 ｜ 整理日期：2026-11-19', 'note')
p('办理顺序：获得 CMS 权限 → 启用 Content ID API → 回到程序重新授权。CMS 需要 YouTube 审批或已有机构邀请，普通频道无法直接打开这个权限。')
p('01  获得 CMS 权限', 'h')
p('情况 A：公司、版权方或合作机构已经有 CMS')
p('1. 请管理员登录 YouTube Studio 内容管理器。<br/>2. 进入“设置 → 权限 → 邀请”。<br/>3. 填写你用于程序授权的 Google 邮箱，分配可管理相关频道、资产和版权政策的角色。<br/>4. 管理员保存后，你到邮箱接受邀请。')
p('这里需要的是“内容管理器”的权限。普通频道中的“管理员”角色不能代替 CMS 权限。', 'note')
link('官方教程：邀请用户加入内容管理器', 'https://support.google.com/youtube/answer/4524878?hl=zh-Hans')
p('情况 B：自己和公司都没有 CMS')
p('1. 打开下方官方申请表，登录 Google 账号。<br/>2. 按表单要求说明你拥有的作品、独家版权证明及管理侵权内容的需求。<br/>3. 等待 YouTube 审核，决定提供哪种版权管理工具。提交申请不保证获得 Content ID 或 CMS。')
link('YouTube 版权管理工具申请表（需登录）', 'https://support.google.com/youtube/contact/copyright_management_tools_form')
link('官方说明：Content ID 申请条件', 'https://support.google.com/youtube/answer/1311402?hl=zh-Hans')
p('YouTube 会考察独家版权及实际版权管理需求。普通非独家授权素材通常不能用作 Content ID 参考内容。', 'note')
p('怎么确认权限已到手？', 'h')
p('在电脑上打开 YouTube，点击右上角头像 → 切换账号。如果列表中的账号下面标有“内容管理器 / Content Manager”，且能正常进入，就说明有 CMS 访问权限。具体功能仍取决于管理员分配的角色。')
link('官方教程：登录内容管理器', 'https://support.google.com/youtube/answer/6301172?hl=zh-Hans')
story.append(PageBreak())
p('启用 API 并连接 DramaBridge', 'title')
p('02  在 Google Cloud 启用 API', 'h')
p('1. 使用拥有 CMS 权限的 Google 账号登录 Google Cloud 控制台。<br/>2. 在顶部选择项目：选之前给 DramaBridge 创建 OAuth 客户端的那个项目。<br/>3. 进入“API 和服务 → 库”。<br/>4. 搜索“YouTube Content ID API”，进入后点击“启用”。<br/>5. 确认同一项目的“YouTube Data API v3”也已启用。')
link('Google Cloud 控制台', 'https://console.cloud.google.com/')
link('Google Cloud API 库（先选择正确项目）', 'https://console.cloud.google.com/apis/library')
p('搜不到 YouTube Content ID API 怎么办？', 'h')
p('先检查当前登录账号是否有 CMS 权限。刚接受 CMS 邀请，需要等待 1～2 天同步；超过两天仍看不到，请联系 YouTube 合作伙伴支持。启用 API 本身不会授予 CMS 权限。')
link('官方说明：Content ID API 访问要求', 'https://developers.google.cn/youtube/partner?hl=en')
p('03  回到程序重新授权', 'h')
p('1. 重启 DramaBridge 中的 YouTube 服务。<br/>2. 打开“账号管理 → 更新授权信息”。<br/>3. 使用刚才拥有 CMS 权限的账号，允许上传和内容管理权限。<br/>4. 确认要上传的频道已关联到该 CMS，再创建任务。')
p('程序默认设置', 'h')
p('上传政策：全球获利<br/>Content ID 匹配：开启<br/>副本匹配政策：全球屏蔽<br/>所有权：全球 100%<br/>资产类型：网络')
p('“全球所有权”必须与你实际拥有的版权地区一致。“全球获利”政策保存后，实际创收仍取决于频道资格及 YouTube 状态。权限不足、版权设置未完成或参考文件尚未激活时，程序会提示失败；通常可稍后重试并复用原视频。', 'note')
p('链接使用说明：本文所有蓝色下划线文字均为可点击链接。Google 登录、项目选择和访问权限仍按你的账号状态执行。', 'note')

def footer(canvas, doc):
    canvas.setStrokeColor(colors.HexColor('#DCE3EB'))
    canvas.line(44, 40, 551, 40)
    canvas.setFont('Harmony', 9)
    canvas.setFillColor(colors.HexColor('#64748B'))
    canvas.drawString(44, 25, 'DramaBridge · YouTube 权利管理指南')
    canvas.drawRightString(551, 25, str(doc.page))

SimpleDocTemplate(str(out), pagesize=(595.28, 841.89), leftMargin=44, rightMargin=44,
                  topMargin=39, bottomMargin=53, title='YouTube CMS 与 Content ID 开通教程',
                  author='DramaBridge').build(story, onFirstPage=footer, onLaterPages=footer)
reader = PdfReader(out)
uris = [str(a.get_object()['/A']['/URI']) for page in reader.pages for a in page.get('/Annots', [])
        if a.get_object().get('/A', {}).get('/S') == '/URI']
assert len(reader.pages) == 2, len(reader.pages)
assert set(uris) == set(links), (uris, links)
print(f'Created {out}; pages={len(reader.pages)}; verified clickable links={len(uris)}')
