import discord
import requests
import os
import asyncio
from discord.ext import commands
from discord.ui import Button, View, Modal, TextInput
from dotenv import load_dotenv

# --- CẤU HÌNH ---
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
try:
    TARGET_CHANNEL_ID = int(os.getenv('CHANNEL_ID'))
except:
    print("❌ LỖI: Chưa cấu hình CHANNEL_ID trong file .env")
    exit()

# Khởi tạo Bot
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

# --- HÀM XỬ LÝ API MICROSOFT ---
def get_outlook_mails(refresh_token, client_id, limit=5):
    """
    Hàm sử dụng Refresh Token để lấy Access Token,
    sau đó gọi Graph API để lấy nội dung mail đầy đủ (Text).
    """
    # 1. Lấy Access Token
    token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    
    payload = {
        'client_id': client_id,
        'grant_type': 'refresh_token',
        'refresh_token': refresh_token,
        'scope': 'https://graph.microsoft.com/.default'
    }

    try:
        response = requests.post(token_url, data=payload)
        token_data = response.json()
        
        if 'access_token' not in token_data:
            return None, f"Lỗi lấy Token: {token_data.get('error_description', 'Token hết hạn hoặc Client ID sai')}"
            
        access_token = token_data['access_token']
    except Exception as e:
        return None, f"Lỗi kết nối Token: {str(e)}"

    # 2. Gọi Graph API để lấy mail
    # Thay đổi: Lấy 'body' thay vì 'bodyPreview'
    api_url = f"https://graph.microsoft.com/v1.0/me/messages?$top={limit}&$select=subject,from,body,receivedDateTime"
    
    headers = {
        'Authorization': f'Bearer {access_token}',
        'Content-Type': 'application/json',
        # QUAN TRỌNG: Yêu cầu trả về dạng Text thay vì HTML để hiển thị đẹp trên Discord
        'Prefer': 'outlook.body-content-type="text"'
    }

    try:
        mail_response = requests.get(api_url, headers=headers)
        
        if mail_response.status_code == 200:
            emails_data = mail_response.json().get('value', [])
            
            results = []
            for mail in emails_data:
                # Lấy nội dung full từ body
                full_content = mail.get('body', {}).get('content', '')
                
                # Nếu nội dung quá ngắn hoặc rỗng
                if not full_content:
                    full_content = "(Không có nội dung)"
                
                results.append({
                    "subject": mail.get('subject', 'Không tiêu đề'),
                    "from": mail.get('from', {}).get('emailAddress', {}).get('address', 'Unknown'),
                    "content": full_content, # Nội dung đầy đủ
                    "date": mail.get('receivedDateTime', '')
                })
            return results, None
        else:
            return None, f"Lỗi API Mail: {mail_response.status_code}"
            
    except Exception as e:
        return None, f"Lỗi kết nối API: {str(e)}"

# --- MODAL (FORM NHẬP LIỆU) ---
class MailInputModal(Modal):
    def __init__(self, limit):
        super().__init__(title=f"Check {limit} thư (Full Content)")
        self.limit = limit

    data_input = TextInput(
        label="Nhập chuỗi: Email|Pass|R_Token|Client_ID",
        placeholder="email|pass|refresh_token|client_id|...",
        style=discord.TextStyle.paragraph,
        required=True,
        min_length=20
    )

    async def on_submit(self, interaction: discord.Interaction):
        raw_data = self.data_input.value.strip()
        
        try:
            parts = raw_data.split("|")
            if len(parts) < 4:
                await interaction.response.send_message("❌ Định dạng sai! Cần tối thiểu: `Email|Pass|Token|ClientID`", ephemeral=True)
                return
            
            email_user = parts[0].strip()
            refresh_token = parts[2].strip()
            client_id = parts[3].strip()

        except Exception as e:
            await interaction.response.send_message(f"❌ Lỗi xử lý chuỗi: {str(e)}", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)

        loop = asyncio.get_event_loop()
        emails, error = await loop.run_in_executor(None, get_outlook_mails, refresh_token, client_id, self.limit)

        if error:
            await interaction.followup.send(f"⚠️ **Thất bại:** {error}", ephemeral=True)
        else:
            # 1. Kiểm tra hộp thư trống
            if not emails:
                await interaction.followup.send(f"📭 **Inbox:** `{email_user}` - Hộp thư trống.", ephemeral=True)
                return

            # 2. Thông báo tìm thấy bao nhiêu thư
            await interaction.followup.send(f"📬 **Inbox:** `{email_user}` - Hiển thị **{len(emails)}** thư mới nhất:", ephemeral=True)

            # 3. Lặp qua từng email và gửi thành TIN NHẮN RIÊNG
            for i, mail in enumerate(emails, 1):
                date_str = mail['date'].replace('T', ' ').split('.')[0]
                content_display = mail['content']

                # Embed Description chứa được 4096 ký tự (nhiều hơn Field rất nhiều)
                if len(content_display) > 4000:
                    content_display = content_display[:4000] + "\n...[Nội dung quá dài, đã bị cắt bớt]..."

                # Tạo Embed riêng cho từng thư
                embed = discord.Embed(
                    title=f"#{i} {mail['subject'][:250]}",
                    description=f"```{content_display}```", # Để nội dung vào đây cho rộng rãi
                    color=0x00ff00
                )
                
                embed.add_field(name="👤 Từ", value=f"`{mail['from']}`", inline=True)
                embed.add_field(name="🕒 Ngày", value=f"`{date_str}`", inline=True)

                # Gửi ngay lập tức (Nằm trong vòng lặp)
                await interaction.followup.send(embed=embed, ephemeral=True)

# --- VIEW ---
class PersistentMailView(View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Check 1 Mail", style=discord.ButtonStyle.primary, emoji="📧", custom_id="btn_graph_1")
    async def btn_1(self, interaction: discord.Interaction, button: Button):
        await interaction.response.send_modal(MailInputModal(limit=1))

    @discord.ui.button(label="Check 3 Mail", style=discord.ButtonStyle.success, emoji="3️⃣", custom_id="btn_graph_3")
    async def btn_3(self, interaction: discord.Interaction, button: Button):
        await interaction.response.send_modal(MailInputModal(limit=3))

    @discord.ui.button(label="Check 5 Mail", style=discord.ButtonStyle.danger, emoji="5️⃣", custom_id="btn_graph_5")
    async def btn_5(self, interaction: discord.Interaction, button: Button):
        await interaction.response.send_modal(MailInputModal(limit=5))

# --- EVENT ---
@bot.event
async def on_ready():
    bot.add_view(PersistentMailView())
    print(f'✅ Bot đã online: {bot.user}')

@bot.command()
async def setup(ctx):
    if ctx.channel.id != TARGET_CHANNEL_ID: return
    
    embed = discord.Embed(
        title="**TOOL CHECK MAIL - FULL CONTENT**",
        description="- **Đọc nội dung chi tiết.**",
        color=0xE74C3C
    )
    embed.add_field(name="Yêu cầu:", value="`Email|Pass|Refresh_Token|Client_ID|...`", inline=False)
    
    await ctx.send(embed=embed, view=PersistentMailView())
    await ctx.message.delete()

if TOKEN:
    bot.run(TOKEN)