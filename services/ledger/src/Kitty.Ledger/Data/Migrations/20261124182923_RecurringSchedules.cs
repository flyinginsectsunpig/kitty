using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class RecurringSchedules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "RecurringSchedules",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Template = table.Column<string>(type: "jsonb", nullable: false),
                    Frequency = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    StartsOn = table.Column<DateOnly>(type: "date", nullable: false),
                    EndsOn = table.Column<DateOnly>(type: "date", nullable: true),
                    NotBefore = table.Column<DateOnly>(type: "date", nullable: false),
                    Paused = table.Column<bool>(type: "boolean", nullable: false),
                    LastAddedPeriod = table.Column<DateOnly>(type: "date", nullable: true),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecurringSchedules", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RecurringSchedules_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RecurringSchedules_GroupId",
                table: "RecurringSchedules",
                column: "GroupId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RecurringSchedules");
        }
    }
}
