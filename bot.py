import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import openai

load_dotenv()

TOKEN = os.getenv("TOKEN")
OPENAI_KEY = os.getenv("OPENAI_KEY")

openai.api_key = OPENAI_KEY

intents = discord.Intents.default()
intents.messages = True
intents.guilds = True
intents.members = True  # REQUIRED for join/leave

bot = commands.Bot(command_prefix="!", intents=intents)

# --------------------
# EVENTS
# --------------------

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user}")

@bot.event
async def on_member_join(member):
    channel = member.guild.system_channel
    if channel:
        await channel.send(f"👋 Welcome {member.mention}!")

@bot.event
async def on_member_remove(member):
    channel = member.guild.system_channel
    if channel:
        await channel.send(f"😢 Goodbye {member.name}...")

# --------------------
# BASIC COMMANDS
# --------------------

@bot.command()
async def hi(ctx):
    await ctx.send(f"Hey {ctx.author.mention} 👋")

@bot.command()
async def helpme(ctx):
    await ctx.send("""
Commands:
!hi
!kick @user
!ban @user
!ai <message>
""")

# --------------------
# ADMIN COMMANDS
# --------------------

@bot.command()
@commands.has_permissions(kick_members=True)
async def kick(ctx, member: discord.Member, *, reason=None):
    await member.kick(reason=reason)
    await ctx.send(f"👢 Kicked {member.mention}")

@bot.command()
@commands.has_permissions(ban_members=True)
async def ban(ctx, member: discord.Member, *, reason=None):
    await member.ban(reason=reason)
    await ctx.send(f"🔨 Banned {member.mention}")

# --------------------
# AI COMMAND
# --------------------

@bot.command()
async def ai(ctx, *, prompt):
    try:
        response = openai.ChatCompletion.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "user", "content": prompt}
            ]
        )

        reply = response.choices[0].message.content
        await ctx.send(reply[:2000])

    except Exception as e:
        await ctx.send("Error with AI.")

# --------------------

bot.run(TOKEN)
