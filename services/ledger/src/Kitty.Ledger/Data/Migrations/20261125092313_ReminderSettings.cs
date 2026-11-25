using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class ReminderSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ReminderEmail",
                table: "NotificationSettings",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "ReminderPush",
                table: "NotificationSettings",
                type: "boolean",
                nullable: false,
                defaultValue: true); // push for reminders is on by default, for people from before 4a too

            migrationBuilder.AddColumn<bool>(
                name: "RemindersPublished",
                table: "NotificationSettings",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ReminderEmail",
                table: "NotificationSettings");

            migrationBuilder.DropColumn(
                name: "ReminderPush",
                table: "NotificationSettings");

            migrationBuilder.DropColumn(
                name: "RemindersPublished",
                table: "NotificationSettings");
        }
    }
}
