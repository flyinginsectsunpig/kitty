using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class NotificationSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "EmailVerified",
                table: "Users",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "NotificationSettings",
                columns: table => new
                {
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ExpensePush = table.Column<bool>(type: "boolean", nullable: false),
                    ExpenseEmail = table.Column<bool>(type: "boolean", nullable: false),
                    PaymentPush = table.Column<bool>(type: "boolean", nullable: false),
                    PaymentEmail = table.Column<bool>(type: "boolean", nullable: false),
                    WeeklyPush = table.Column<bool>(type: "boolean", nullable: false),
                    WeeklyEmail = table.Column<bool>(type: "boolean", nullable: false),
                    Version = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NotificationSettings", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_NotificationSettings_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "PushDevices",
                columns: table => new
                {
                    Token = table.Column<string>(type: "character varying(4096)", maxLength: 4096, nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Platform = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PushDevices", x => x.Token);
                    table.ForeignKey(
                        name: "FK_PushDevices_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PushDevices_UserId",
                table: "PushDevices",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "NotificationSettings");

            migrationBuilder.DropTable(
                name: "PushDevices");

            migrationBuilder.DropColumn(
                name: "EmailVerified",
                table: "Users");
        }
    }
}
