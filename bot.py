from keep_alive import keep_alive
import discord
import requests
import os
import asyncio
import time  # Thêm thư viện này để dùng chức năng sleep
from discord.ext import commands
from discord.ui import Button, View, Modal, TextInput
from dotenv import load_dotenv

# --- CẤU HÌNH ---
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')

# 1. TÍNH NĂNG ĐA KÊNH (MULTIPLE CHANNELS)
raw_ids = os.getenv('ALLOWED_CHANNELS', '')
try:
    ALLOWED_CHANNEL_IDS = [int(x.strip()) for x in raw_ids.split(',') if x.strip().isdigit()]
    if not ALLOWED_CHANNEL_IDS:
        print("⚠️ CẢNH BÁO: Biến ALLOWED_CHANNELS đang trống!")
    else:
        print(f"✅ Các kênh được phép hoạt động: {ALLOWED_CHANNEL_IDS}")
except Exception as e:
    print(f"❌ Lỗi cấu hình ALLOWED_CHANNELS: {e}")
    ALLOWED_CHANNEL_IDS = []

# Khởi tạo Bot
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

# --- HÀM XỬ LÝ API MICROSOFT ---
def get_outlook_mails(refresh_token, client_id, limit=5):
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
    api_url = f"https://graph.microsoft.com/v1.0/me/messages?$top={limit}&$select=subject,from,body,receivedDateTime"
    headers = {
        'Authorization': f'Bearer {access_token}',
        'Content-Type': 'application/json',
        'Prefer': 'outlook.body-content-type="text"'
    }

    try:
        mail_response = requests.get(api_url, headers=headers)
        if mail_response.status_code == 200:
            emails_data = mail_response.json().get('value', [])
            results = []
            for mail in emails_data:
                full_content = mail.get('body', {}).get('content', '')
                if not full_content:
                    full_content = "(Không có nội dung)"
                
                results.append({
                    "subject": mail.get('subject', 'Không tiêu đề'),
                    "from": mail.get('from', {}).get('emailAddress', {}).get('address', 'Unknown'),
                    "content": full_content,
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
            if not emails:
                await interaction.followup.send(f"📭 **Inbox:** `{email_user}` - Hộp thư trống.", ephemeral=True)
                return

            await interaction.followup.send(f"📬 **Inbox:** `{email_user}` - Hiển thị **{len(emails)}** thư mới nhất:", ephemeral=True)
            for i, mail in enumerate(emails, 1):
                date_str = mail['date'].replace('T', ' ').split('.')[0]
                content_display = mail['content']
                if len(content_display) > 4000:
                    content_display = content_display[:4000] + "\n...[Nội dung quá dài, đã bị cắt bớt]..."

                embed = discord.Embed(
                    title=f"#{i} {mail['subject'][:250]}",
                    description=f"```{content_display}```", 
                    color=0x00ff00
                )
                embed.add_field(name="👤 Từ", value=f"`{mail['from']}`", inline=True)
                embed.add_field(name="🕒 Ngày", value=f"`{date_str}`", inline=True)
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
    if ctx.channel.id not in ALLOWED_CHANNEL_IDS:
        return
    
    embed = discord.Embed(
        title="**TOOL CHECK MAIL - FULL CONTENT**",
        description="- **Đọc nội dung chi tiết.**",
        color=0xE74C3C
    )
    embed.add_field(name="Yêu cầu:", value="`Email|Pass|Refresh_Token|Client_ID|...`", inline=False)
    await ctx.send(embed=embed, view=PersistentMailView())
    try:
        await ctx.message.delete()
    except:
        pass

# --- MAIN EXECUTION (CÓ FIX LỖI 429) ---
if __name__ == "__main__":
    # Chạy Web Server (Flask) ở luồng riêng
    keep_alive()
    
    if TOKEN:
        try:
            print("⏳ Đang khởi động bot...")
            bot.run(TOKEN)
        except discord.errors.HTTPException as e:
            # Bắt lỗi 429 (Too Many Requests)
            if e.status == 429:
                print("\n" + "="*40)
                print("🛑 LỖI RATE LIMIT (429) TỪ DISCORD!")
                print("Bot sẽ tạm dừng 60 giây để tránh bị ban IP lâu hơn.")
                print("Lưu ý: Nếu lỗi này lặp lại, hãy đổi Region trên Render.")
                print("="*40 + "\n")
                time.sleep(60) # Ngủ 60s để làm nguội IP
            else:
                # Các lỗi HTTP khác
                print(f"❌ Lỗi HTTP: {e}")
                time.sleep(10)
        except Exception as e:
            # Các lỗi hệ thống khác
            print(f"❌ Lỗi không mong muốn: {e}")
            time.sleep(10)
    else:
        print("❌ LỖI: Chưa tìm thấy DISCORD_TOKEN trong biến môi trường!")