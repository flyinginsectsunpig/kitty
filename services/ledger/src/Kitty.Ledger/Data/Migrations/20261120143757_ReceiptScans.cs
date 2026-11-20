using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class ReceiptScans : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ReceiptScans",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    SessionId = table.Column<Guid>(type: "uuid", nullable: false),
                    BlobName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    ContentType = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    FailureReason = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    SuggestionJson = table.Column<string>(type: "jsonb", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UploadedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    FinishedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    AppliedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    BlobDeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ReceiptScans", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ReceiptScans_ReceiptSessions_SessionId",
                        column: x => x.SessionId,
                        principalTable: "ReceiptSessions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ReceiptScans_SessionId_CreatedAt",
                table: "ReceiptScans",
                columns: new[] { "SessionId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ReceiptScans");
        }
    }
}
